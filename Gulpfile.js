const gulp = require('gulp');
const through = require('through2');
const { Project, SyntaxKind } = require('ts-morph');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const { exit } = require('process');

const runCommand = command => {
  return cb => {
    exec(command, function (err, stdout, stderr) {
      console.log(stdout);
      console.log(stderr);
      cb(err);
    });
  };
};

gulp.task('husky-install', runCommand('npx husky install'));
gulp.task('husky-add', function (cb) {
  const huskyFilePath = path.join('.husky', 'pre-commit');
  const command = 'npm run precommit';

  fs.readFile(huskyFilePath, 'utf8', function (err, data) {
    if (err) {
      return cb(err);
    }

    if (!data.includes(command)) {
      exec(
        `npx husky add ${huskyFilePath} "${command}"`,
        function (err, stdout, stderr) {
          console.log(stdout);
          console.log(stderr);
          cb(err);
        }
      );
    } else {
      cb();
    }
  });
});
gulp.task('format', runCommand('npm run format'));
gulp.task('setup', gulp.series('husky-install', 'husky-add', 'format'));

gulp.task('DB:addMeta', function (done) {
  const migrationsDir = path.join(__dirname, './migrations');

  // Check if the directory exists
  if (!fs.existsSync(migrationsDir)) {
    throw new Error('Directory ./migrations does not exist.');
  }

  // drizzle-kit >= 1.0 writes one folder per migration:
  // migrations/<timestamp>_<slug>/snapshot.json
  const snapshotFiles = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => path.join(migrationsDir, dirent.name, 'snapshot.json'))
    .filter(filePath => fs.existsSync(filePath));

  if (snapshotFiles.length === 0) {
    throw new Error(
      'No migrations/<timestamp>_<slug>/snapshot.json files found.'
    );
  }

  for (const filePath of snapshotFiles) {
    let data = fs.readFileSync(filePath, 'utf8');

    let json = JSON.parse(data);

    // Add '_meta' property if it doesn't exist
    if (!json._meta) {
      json._meta = {};
    }

    // Add 'schemas', 'tables', and 'columns' properties to '_meta' if they don't exist
    if (!json._meta.schemas) {
      json._meta.schemas = {};
    }

    if (!json._meta.tables) {
      json._meta.tables = {};
    }

    if (!json._meta.columns) {
      json._meta.columns = {};
    }

    // Write the modified JSON back to the file
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');

    console.log(
      `Added _meta to ${path.basename(path.dirname(filePath))}/snapshot.json`
    );
  }

  done();
});

gulp.task('DB:checkSchemaAndRefreshTestDataFiles', function (done) {
  console.log('Checking schema and refresh test data files');

  const directory = './schema';
  const requiredFiles = ['refreshTestData.ts', 'schema.ts'];

  // Read the schema directory
  fs.readdir(directory, (err, filesOrDirs) => {
    if (err) {
      done(err);
      return;
    }

    // Loop over each item
    filesOrDirs.forEach(item => {
      const itemPath = path.join(directory, item);

      // Check if item is a directory
      if (fs.lstatSync(itemPath).isDirectory()) {
        // Read the contents of the directory
        const dirContents = fs.readdirSync(itemPath);

        // Check if there are extra files or if a required file is missing
        const extraFiles = dirContents.filter(
          file => !requiredFiles.includes(file)
        );
        const missingFiles = requiredFiles.filter(
          file => !dirContents.includes(file)
        );

        if (extraFiles.length > 0) {
          done(
            new Error(
              `Extra files "${extraFiles.join(', ')}" found in ${itemPath}`
            )
          );
          return;
        } else if (missingFiles.length > 0) {
          done(
            new Error(
              `Missing files "${missingFiles.join(', ')}" in ${itemPath}`
            )
          );
          return;
        }
      } else {
        if (path.normalize(itemPath) !== path.normalize('schema/util.ts')) {
          done(new Error(`Unexpected file "${item}" found in ./schema`));
          return;
        }
      }
    });

    console.log('Schema and refresh test data files are valid');
    done();
  });
});

gulp.task('DB:applyMigration', async function (cb) {
  const dotenv = require('dotenv');
  const tsNode = require('ts-node');
  const { migrate } = require('drizzle-orm/postgres-js/migrator');
  const postgres = require('postgres');
  const { drizzle } = require('drizzle-orm/postgres-js');

  tsNode.register({
    transpileOnly: true, // speed up compilation
  });

  dotenv.config();

  function isFullyCommented(content) {
    // remove the block between /* and */
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');

    // split the remaining content into lines
    const lines = content.split('\n');

    // filter out the commented lines
    const uncommentedLines = lines.filter(
      line => !line.trim().startsWith('--') && line.trim() !== ''
    );

    return uncommentedLines.length === 0;
  }

  console.log('Applying migration');

  // for migrations
  const url = `${process.env.DATABASE_URL}`;
  const db = drizzle({
    client: postgres(url, {
      ssl: process.env.PGSSL === 'disable' ? false : 'require',
      max: 1,
    }),
  });

  // get all sql files in the migrations folder
  // (drizzle-kit >= 1.0 layout: <folder>/migration.sql, plus legacy top-level .sql)
  const migrationsFolderPath = path.resolve(__dirname, './migrations');
  const files = [];

  for (const entry of fs.readdirSync(migrationsFolderPath, {
    withFileTypes: true,
  })) {
    if (entry.isFile() && path.extname(entry.name) === '.sql') {
      files.push(path.join(migrationsFolderPath, entry.name));
    } else if (entry.isDirectory()) {
      const nested = path.join(
        migrationsFolderPath,
        entry.name,
        'migration.sql'
      );
      if (fs.existsSync(nested)) {
        files.push(nested);
      }
    }
  }

  for (const filePath of files) {
    let fileContent = fs.readFileSync(filePath, 'utf8');

    // Check if the file is fully commented out
    const isCommentedOut = isFullyCommented(fileContent);

    if (isCommentedOut) {
      console.log(
        `Migration file ${filePath} is completely commented out, removing "statement-breakpoint" line.`
      );
      fileContent = fileContent
        .split('\n')
        .filter(line => line.trim() !== '--> statement-breakpoint')
        .join('\n');
      fs.writeFileSync(filePath, fileContent, 'utf8');
    }
  }

  try {
    await migrate(db, { migrationsFolder: './migrations' });
    console.log('Migration applied successfully');
    cb();
    exit(0);
  } catch (err) {
    console.error('Migration failed: ', err);
    cb();
    exit(1);
  }
});

gulp.task('DB:refreshTestData', async function () {
  console.log('Refreshing test data');

  // Get all subdirectories
  const subdirs = fs
    .readdirSync('./schema', { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  // Create a promisified instance of exec just for this task
  const execAsync = util.promisify(exec);

  // Run exec for each subdir
  let execPromises = subdirs.map(async subdir => {
    const filePath = path.normalize(`./schema/${subdir}/refreshTestData.ts`);
    if (fs.existsSync(filePath)) {
      console.log(`Executing file at ${filePath}`);
      try {
        const { stdout, stderr } = await execAsync(`npx ts-node ${filePath}`);
        console.log(stdout);
        if (stderr) console.error(stderr);
      } catch (err) {
        console.error(err);
      }
    }
  });

  await Promise.all(execPromises);
  console.log('Done refreshing test data');
});

gulp.task('DB:validate-identifiers', function () {
  const project = new Project({ compilerOptions: { allowJs: true } });

  function validateIdentifier(id, filePath) {
    const bannedSymbols = [
      // Go keywords
      'break',
      'default',
      'func',
      'interface',
      'select',
      'case',
      'defer',
      'go',
      'map',
      'struct',
      'chan',
      'else',
      'goto',
      'package',
      'switch',
      'const',
      'fallthrough',
      'if',
      'range',
      'type',
      'continue',
      'for',
      'import',
      'return',
      'var',

      // SQL keywords (ANSI and some common dialects)
      'add',
      'all',
      'alter',
      'and',
      'any',
      'as',
      'asc',
      'backup',
      'between',
      'by',
      'case',
      'check',
      'column',
      'constraint',
      'create',
      'database',
      'default',
      'delete',
      'desc',
      'distinct',
      'drop',
      'else',
      'end',
      'exists',
      'foreign',
      'from',
      'full',
      'group',
      'having',
      'in',
      'index',
      'inner',
      'insert',
      'intersect',
      'into',
      'is',
      'join',
      'left',
      'like',
      'limit',
      'not',
      'null',
      'or',
      'order',
      'outer',
      'primary',
      'right',
      'select',
      'set',
      'table',
      'top',
      'union',
      'unique',
      'update',
      'values',
      'where',

      // MySQL-specific keywords
      'describe',
      'regexp',
      'tinyint',
      'smallint',
      'mediumint',
      'bigint',
      'datetime',
      'longtext',

      // PostgreSQL-specific keywords
      'serial',
      'bigserial',
      'timestamp',

      // SQLite-specific keywords
      'replace',
      'pragma',

      // MS SQL Server-specific keywords
      'identity',
      'nvarchar',
      'bit',
    ];
    // Check if identifier starts with a digit
    if (/\d/.test(id.charAt(0))) {
      throw new Error(
        `Identifier "${id}" in file "${filePath}" is not valid. It starts with a digit.`
      );
    }
    // Check if identifier contains only allowed characters (letters, digits and underscore)
    if (!/^[a-zA-Z0-9_]+$/.test(id)) {
      throw new Error(
        `Identifier "${id}" in file "${filePath}" is not valid. It contains characters other than letters, digits and underscore.`
      );
    }
    // Check if identifier is not a banned symbol
    if (bannedSymbols.includes(id)) {
      throw new Error(
        `Identifier "${id}" in file "${filePath}" is not valid. It is a reserved word in Go or SQL.`
      );
    }
  }

  return gulp.src('./schema/**/schema.ts').pipe(
    through.obj(function (file, _, cb) {
      const sourceFile = project.addSourceFileAtPath(file.path);

      sourceFile
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .forEach(callExpression => {
          const expression = callExpression.getExpression();
          if (
            expression.getText() === 'pgEnum' ||
            expression.getText() === 'pgTable'
          ) {
            callExpression.getArguments().forEach(arg => {
              if (arg.getKind() === SyntaxKind.StringLiteral) {
                validateIdentifier(arg.getLiteralText(), file.path);
              } else if (arg.getKind() === SyntaxKind.ArrayLiteralExpression) {
                arg.getElements().forEach(element => {
                  validateIdentifier(element.getLiteralText(), file.path);
                });
              } else if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                arg.getProperties().forEach(prop => {
                  const propName = prop.getName();
                  if (propName) {
                    validateIdentifier(propName, file.path);
                    // Get the first string literal argument of the function in the property value
                    const funcArg = prop.getFirstDescendantByKind(
                      SyntaxKind.StringLiteral
                    );
                    if (funcArg && funcArg.getLiteralText() !== propName) {
                      throw new Error(
                        `The property key "${propName}" does not match the function argument "${funcArg.getLiteralText()}" in file "${
                          file.path
                        }".`
                      );
                    }
                  }
                });
              }
            });
          }
        });

      cb(null, file);
    })
  );
});

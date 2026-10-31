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

gulp.task('DB:checkOldLayout', function (done) {
  const oldJournal = path.join(
    __dirname,
    'migrations',
    'meta',
    '_journal.json'
  );

  // drizzle-orm 1.0's migrate() upgrades the migrations table once (upToV1)
  // and refuses to continue when database rows do not match a local migration.
  // Regenerating the folder (DB:createNewMigration does rimraf migrations) on a
  // machine whose database predates the 1.0 upgrade leaves the database
  // unrecoverable, so fail early and point at the working remediation.
  if (fs.existsSync(oldJournal)) {
    done(
      new Error(
        'Old-layout migrations folder. Run "npx drizzle-kit up" first so the ' +
          'database migrations table can be upgraded, then retry.'
      )
    );
    return;
  }

  done();
});

gulp.task('DB:checkMigrationTable', async function (cb) {
  // drizzle-orm 1.0's migrate() upgrades a 0.31-era migrations table (no
  // name/applied_at columns) by matching every database row to a local
  // migration (created_at second, sha256 hash tie-break) and refuses to run
  // when a row matches nothing. The local folder is gitignored, so a fresh
  // clone (and CI) has no folder at all and every database row is
  // unmatched — the case DB:checkOldLayout (folder on disk) cannot see.
  // Check the database itself, before migrations are deleted (rimraf) or
  // applied, and fail early with the working remediation.
  const dotenv = require('dotenv');
  const crypto = require('crypto');
  const postgres = require('postgres');

  dotenv.config();

  const url = process.env.DATABASE_URL;
  if (!url) {
    cb(
      new Error(
        'DATABASE_URL is not set; cannot check the database migrations table.'
      )
    );
    return;
  }

  // Same local-migration shape as drizzle-orm's readMigrationFiles():
  // one folder per migration, <folder>/migration.sql, folder name =
  // <14-digit UTC timestamp>_<slug>.
  const migrationsDir = path.join(__dirname, 'migrations');
  const localMigrations = [];
  if (fs.existsSync(migrationsDir)) {
    for (const dirent of fs.readdirSync(migrationsDir, {
      withFileTypes: true,
    })) {
      if (!dirent.isDirectory()) continue;
      const filePath = path.join(migrationsDir, dirent.name, 'migration.sql');
      if (!fs.existsSync(filePath)) continue;
      const digits = dirent.name.slice(0, 14);
      localMigrations.push({
        name: dirent.name,
        folderMillis: Date.UTC(
          parseInt(digits.slice(0, 4), 10),
          parseInt(digits.slice(4, 6), 10) - 1,
          parseInt(digits.slice(6, 8), 10),
          parseInt(digits.slice(8, 10), 10),
          parseInt(digits.slice(10, 12), 10),
          parseInt(digits.slice(12, 14), 10)
        ),
        hash: crypto
          .createHash('sha256')
          .update(fs.readFileSync(filePath, 'utf8'))
          .digest('hex'),
      });
    }
  }

  const sql = postgres(url, {
    ssl: process.env.PGSSL === 'disable' ? false : 'require',
    max: 1,
  });

  try {
    const tables = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'drizzle'
      AND table_name = '__drizzle_migrations'
    `;
    if (tables.length === 0) {
      console.log(
        'No drizzle.__drizzle_migrations table in the database; nothing to check.'
      );
      cb();
      return;
    }

    const columns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'drizzle'
      AND table_name = '__drizzle_migrations'
    `;
    if (columns.some(column => column.column_name === 'name')) {
      // v1 table: the 1.0 migrator matches local migrations by name and
      // never throws for database rows, so every row is accounted for.
      console.log(
        'Database migrations table is v1 (name column present); database check passed.'
      );
      cb();
      return;
    }

    // v0 table (drizzle-kit 0.31 era): mirror upToV1's row matching.
    const rows = await sql`
      SELECT id, hash, created_at FROM drizzle.__drizzle_migrations
      ORDER BY id ASC
    `;
    const byMillis = new Map();
    const byHash = new Map();
    for (const lm of localMigrations) {
      if (!byMillis.has(lm.folderMillis)) byMillis.set(lm.folderMillis, []);
      byMillis.get(lm.folderMillis).push(lm);
      byHash.set(lm.hash, lm);
    }
    const unmatchedIds = [];
    for (const row of rows) {
      const stringified = String(row.created_at);
      const millis = Number(
        stringified.substring(0, stringified.length - 3) + '000'
      );
      const candidates = byMillis.get(millis);
      let matched;
      if (candidates && candidates.length === 1) matched = candidates[0];
      else if (candidates && candidates.length > 1)
        matched = candidates.find(candidate => candidate.hash === row.hash);
      else matched = byHash.get(row.hash);
      if (!matched) unmatchedIds.push(row.id);
    }
    if (unmatchedIds.length > 0) {
      cb(
        new Error(
          `Database migrations table (drizzle-kit 0.31 era) holds ${unmatchedIds.length} ` +
            `migration(s) (ids: ${unmatchedIds.join(', ')}) that the local migrations ` +
            'folder cannot account for; the 1.0 migrator will refuse to apply. ' +
            'One-time remedy (works on a fresh clone, without a local migrations folder):\n' +
            '  1. git checkout main (main is still on drizzle-kit 0.31)\n' +
            '  2. npx drizzle-kit generate (creates the 0.31-layout folder; skip if you already have it)\n' +
            '  3. git checkout <this branch> (the gitignored folder stays on disk)\n' +
            "  4. npx drizzle-kit up (the branch's drizzle-kit 1.0 converts the folder)\n" +
            '  5. If the database was built by DB:createNewMigration on an empty database (the shape the README workflow and the push workflow create), the empty baseline migration cannot be regenerated, so delete its row first (no schema is lost; the row is empty):\n' +
            '     DELETE FROM drizzle.__drizzle_migrations WHERE id = 1;\n' +
            '  6. npm run DB:applyMigration (the 1.0 migrator upgrades the database table and backfills the name)\n' +
            'In a dev database you may instead drop and recreate the database.'
        )
      );
      return;
    }
    console.log(
      `All ${rows.length} database migration(s) match the local migrations folder; database check passed.`
    );
    cb();
  } catch (err) {
    cb(err);
  } finally {
    await sql.end().catch(() => {});
  }
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

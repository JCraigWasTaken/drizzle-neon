const gulp = require('gulp');
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
gulp.task(
  'pullSchemaIfDoesNotExist',
  runCommand('npx drizzle-kit introspect:pg --config=drizzle.config.ts')
);
gulp.task('DB:addMeta', function (done) {
  const filePath = path.join(__dirname, './migrations/meta/0000_snapshot.json');

  // Check if the file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(
      'File ./migrations/meta/0000_snapshot.json does not exist.'
    );
  }

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

  console.log('Added _meta to 0000_snapshot.json');
  done();
});
gulp.task(
  'setup',
  gulp.series(
    'husky-install',
    'husky-add',
    'format',
    'pullSchemaIfDoesNotExist',
    'DB:addMeta'
  )
);

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
  const url = `${process.env.DATABASE_URL}?options=project%3D${process.env.PROJECT_NAME}`;
  const db = drizzle(postgres(url, { ssl: 'require', max: 1 }));

  // get all sql files in the migrations folder
  const migrationsFolderPath = path.resolve(__dirname, './migrations');
  const files = fs.readdirSync(migrationsFolderPath);

  for (const file of files) {
    if (path.extname(file) === '.sql') {
      const filePath = path.join(migrationsFolderPath, file);
      let fileContent = fs.readFileSync(filePath, 'utf8');

      // Check if the file is fully commented out
      const isCommentedOut = isFullyCommented(fileContent);

      if (isCommentedOut) {
        console.log(
          `Migration file ${file} is completely commented out, removing "statement-breakpoint" line.`
        );
        fileContent = fileContent
          .split('\n')
          .filter(line => line.trim() !== '--> statement-breakpoint')
          .join('\n');
        fs.writeFileSync(filePath, fileContent, 'utf8');
      }
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

# Drizzle-Neon

## Description

This repository serves as a Node.js TypeScript project that utilizes Drizzle for managing database tables in a Neon distributed Postgres database. The main purpose of this repository is to define database tables, generate migrations, apply migrations, and generate and insert test data. The following instructions will guide you through the workflow for using this repository effectively.

## Development Requirements

Before proceeding with the setup and workflow, ensure that you have the following prerequisites:

- Node.js (v18+ recommended)
- NPM (v9+ recommended)
- Visual Studio Code
- Prettier Extension for Visual Studio Code
- Access to a neon database and ability to get connection information.

## Setup

### Development Environment

1. Install Visual Studio Code, if not already installed.
2. Install the prettier extension for vscode, if not already installed.
3. Open settings (File > Preferences > Settings or Ctrl + ,).
4. Search for "Editor: Default Formatter" and select "Prettier - Code formatter" from the dropdown.
5. Search for "editor.formatOnSave" and enable it.
6. Save your settings.
7. Run `npm run setup` from the project root directory.

### Github Actions (If cloning this repo)

1. Go to your project dashboard on Neon and select the production branch in the "Connection Details" section. Click on "Direct connection" in the "Connection Details" section and copy the connection string.
2. Go to your repository on Github and navigate to Settings > Secrets.
3. Click on "New repository secret" and create a secret named `DATABASE_URL_PROD` with the value of the connection string you copied from Neon, adding `?sslmode=require` to the end of the string.
4. Go to your project dashboard on Neon and select the dev branch in the "Connection Details" section. Click on "Direct connection" in the "Connection Details" section and copy the connection string.
5. Go to your repository on Github and navigate to Settings > Secrets.
6. Click on "New repository secret" and create a secret named `DATABASE_URL_DEV` with the value of the connection string you copied from Neon, adding `?sslmode=require` to the end of the string.

## Workflow

### 1. Create a new test branch off of the 'dev' branch on Neon

Create a new branch on the Neon with 'dev' as it's parent branch. This will provide you with a separate environment for making and testing changes to the database schema.

### 2. Create a connection string

To establish a connection between your local environment and Neon database, follow these steps:

a. On Neon navigate to your project dashboard and select the branch you created in step 1.

b. Click on "Direct connection" in the "Connection Details" section and copy the connection string.

c. Create a `.env` file in the root directory of the project add the following lines to it:

```shell
DATABASE_URL=<connection string>?sslmode=require
```

d. Replace `<connection string>` with the connection string you copied from Neon.

### 3. Install dependencies

In order to run the required scripts and set up the project, you need to download all the necessary dependencies and set up husky hooks. Run the following command in your terminal:

```shell
npm run setup
```

### 4. Make changes to the table schema

Navigate to the `./schema` directory and make the necessary changes to the table schema files. These schema files define the structure of the database tables.

### 5. Generate migration files

To automatically generate migration files for your changes, run the following command:

```shell
npm run DB:createNewMigration
```

This command will check your schema and refreshTestData files to ensure they are valid, and then generate migration files based on the changes you made.

### 6. Verify migration files

Once the migration files are generated, review them to ensure they reflect the intended changes accurately. Confirm that the migration files align with your desired table schema modifications.

### 7. Apply migrations

To apply the generated migration files to the Neon database, execute the following command:

```shell
npm run DB:applyMigration
```

This command will apply the migrations and update the database schema accordingly.

### 8. Insert test data

After applying the migrations, it is recommended to insert test data into the newly changed tables. To accomplish this, run the following command:

```shell
npm run DB:refreshTestData
```

This command will update the tables with the relevant test data.

### 9. Test and iterate

At this point, you can test your changes and iterate the process if needed. If further modifications to the table schema are required, repeat steps 4 to 8 accordingly.

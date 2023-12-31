import { faker } from '@faker-js/faker';
import {
  EquationTable,
  TEquationTableRow,
  TEquationTableColumns,
} from './schema';
import { RefreshTestData, roundToTwoDecimalPlaces } from '../util';

class RefreshEquationTestDataClass extends RefreshTestData<
  TEquationTableRow,
  TEquationTableColumns
> {
  generateRow(): TEquationTableRow {
    const operations = ['plus', 'minus', 'times', 'divide'];
    let date = faker.date.past({
      years: 1,
      refDate: new Date(),
    });
    let varA = roundToTwoDecimalPlaces(
      faker.number.float({ min: 0.1, max: 100.0 })
    );
    let varB = roundToTwoDecimalPlaces(
      faker.number.float({ min: 0.1, max: 100.0 })
    );
    let operation = faker.helpers.arrayElement(
      operations
    ) as TEquationTableRow['operation'];

    let result: number = 0;

    switch (operation) {
      case 'plus':
        result = varA + varB;
        break;
      case 'minus':
        result = varA - varB;
        break;
      case 'times':
        result = varA * varB;
        break;
      case 'divide':
        // ensure we're not dividing by zero
        if (varB !== 0) {
          result = varA / varB;
        } else {
          // if varB is zero, set operation to '+' and calculate the result
          operation = 'plus';
          result = varA + varB;
        }
        break;
    }

    result = roundToTwoDecimalPlaces(result);

    return {
      date,
      varA: varA.toString(),
      operation,
      varB: varB.toString(),
      result: result.toString(),
    };
  }
}

const main = async () => {
  const RefreshEquationTestData = new RefreshEquationTestDataClass(
    1,
    EquationTable,
    25
  );
  console.log('Refreshing equation test data...');
  await RefreshEquationTestData.deleteAllRowsFromDBTable();
  await RefreshEquationTestData.pushRowsToDBTable();
  console.log('Equation test data refreshed.');
  process.exit(0);
};

main();

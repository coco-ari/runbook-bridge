import { APP_VERSION } from '../src/package-metadata.mjs';

const arguments_ = process.argv.slice(2);
const expectedRefName = `v${APP_VERSION}`;

if (arguments_.length !== 1 || !arguments_[0]) {
  console.error(`Release version check failed: expected exactly one explicit tag/ref name argument (for example, ${expectedRefName}).`);
  process.exitCode = 1;
} else if (arguments_[0] !== expectedRefName) {
  console.error(`Release version check failed: ref name ${JSON.stringify(arguments_[0])} does not match package.json version ${JSON.stringify(APP_VERSION)}; expected exactly ${JSON.stringify(expectedRefName)}.`);
  process.exitCode = 1;
} else {
  console.log(`Release version verified: ${expectedRefName} matches package.json version ${APP_VERSION}.`);
}

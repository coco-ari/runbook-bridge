import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = require('../package.json');

export const APP_VERSION = manifest.version;

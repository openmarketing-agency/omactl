import pkg from '../../package.json';
declare const OMA_BUILD_VERSION: string;
export const VERSION = typeof OMA_BUILD_VERSION === 'undefined' ? pkg.version : OMA_BUILD_VERSION;

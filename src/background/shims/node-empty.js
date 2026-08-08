// Inert stand-in for Node built-ins that the Anthropic SDK only touches on
// Node (credential files on disk). Nothing in the extension reaches these
// code paths, because the API key is always supplied explicitly.
const notAvailable = () => {
  throw new Error("Node built-in modules are not available in the extension service worker");
};

export const readFileSync = notAvailable;
export const promises = new Proxy({}, { get: notAvailable });
export const existsSync = () => false;
export const join = notAvailable;
export const resolve = notAvailable;
export default {};

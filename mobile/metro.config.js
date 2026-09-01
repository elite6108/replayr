const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const socialTypes = path.resolve(projectRoot, "../packages/social-types/index.ts");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.resolve(projectRoot, "../packages")];

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.replace(/\\/g, "/").endsWith("packages/social-types/index")) {
    return { type: "sourceFile", filePath: socialTypes };
  }
  if (defaultResolve) return defaultResolve(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

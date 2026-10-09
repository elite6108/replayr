const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const socialTypes = path.resolve(projectRoot, "../packages/social-types/index.ts");
const editorSegments = path.resolve(projectRoot, "../src/components/editor/segments.ts");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [
  path.resolve(projectRoot, "../packages"),
  path.resolve(projectRoot, "../src/components/editor"),
];

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const name = moduleName.replace(/\\/g, "/");
  if (name.endsWith("packages/social-types/index")) {
    return { type: "sourceFile", filePath: socialTypes };
  }
  if (name.endsWith("src/components/editor/segments.ts") || name.endsWith("src/components/editor/segments")) {
    return { type: "sourceFile", filePath: editorSegments };
  }
  if (defaultResolve) return defaultResolve(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

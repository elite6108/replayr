// Lets `node --test` run the app's TypeScript modules directly. Node strips the types itself;
// this hook only resolves the extensionless relative imports the Vite build allows.
import { registerHooks } from "node:module";

const CANDIDATES = [".ts", ".tsx", "/index.ts"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      for (const suffix of CANDIDATES) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          /* try the next candidate */
        }
      }
      throw error;
    }
  },
});

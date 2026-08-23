import * as SecureStore from "expo-secure-store";

const CHUNK = 1800;

export const sessionStorage = {
  async getItem(key: string) {
    const chunks = Number(await SecureStore.getItemAsync(`${key}_n`));
    if (!Number.isFinite(chunks) || chunks <= 0) return SecureStore.getItemAsync(key);
    const parts: string[] = [];
    for (let index = 0; index < chunks; index += 1) {
      parts.push((await SecureStore.getItemAsync(`${key}_${index}`)) ?? "");
    }
    return parts.join("");
  },
  async setItem(key: string, value: string) {
    const count = Math.max(1, Math.ceil(value.length / CHUNK));
    await SecureStore.setItemAsync(`${key}_n`, String(count));
    for (let index = 0; index < count; index += 1) {
      await SecureStore.setItemAsync(`${key}_${index}`, value.slice(index * CHUNK, (index + 1) * CHUNK));
    }
  },
  async removeItem(key: string) {
    const chunks = Number(await SecureStore.getItemAsync(`${key}_n`));
    await SecureStore.deleteItemAsync(`${key}_n`);
    await SecureStore.deleteItemAsync(key);
    if (Number.isFinite(chunks)) {
      for (let index = 0; index < chunks; index += 1) {
        await SecureStore.deleteItemAsync(`${key}_${index}`);
      }
    }
  },
};

/* eslint-disable no-console */
const isProd = process.env.NODE_ENV === "production";

export const log = {
  info: (...args: unknown[]) => {
    if (!isProd) console.log("[info]", ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn("[warn]", ...args);
  },
  error: (...args: unknown[]) => {
    console.error("[error]", ...args);
  },
};

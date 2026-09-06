"use strict";

module.exports = {
  register() {
    const registerInstrumentation = globalThis.__ahivimInstrumentationRegister;
    if (typeof registerInstrumentation !== "function") {
      throw new Error("The instrumentation test callback is not installed.");
    }
    return registerInstrumentation();
  },
};

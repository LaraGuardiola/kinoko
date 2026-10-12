// kinoko's version: package.json's, the one place it is written (a compiled binary carries it).

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

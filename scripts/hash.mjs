import bcrypt from "../../node_modules/.pnpm/bcryptjs@2.4.3/node_modules/bcryptjs/dist/bcrypt.js";

const hash = await bcrypt.hash("Silentwolf906", 10);
console.log(hash);
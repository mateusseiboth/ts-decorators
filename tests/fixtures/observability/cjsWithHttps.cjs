// Simula um pacote CommonJS (o follow-redirects do axios) que carrega o `https` pelo `require`.
const https = require("https");

module.exports = { agent: https.globalAgent };

import fs from "fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // React plugin zabezpečí spracovanie JSX a TSX súborov počas vývoja
  // aj pri buildovaní sieťovej klientskej vetvy.
  plugins: [react()],

  server: {
    // V sieťovej simulácii sa hodí sprístupniť aj vývojový klient do LAN,
    // aby ho bolo možné testovať z iných zariadení.
    host: "0.0.0.0",

    // Frontend beží cez HTTPS, aby zostal kompatibilný s backendom aj
    // lokálnym agentom a nenarážal na obmedzenia prehliadača.
    https: {
      key: fs.readFileSync("../server/tls/key.pem"),
      cert: fs.readFileSync("../server/tls/cert.pem"),
    },
    port: 5173,
    proxy: {
      // Volania na `/api` v režime vývoja presmerujeme na backend, takže
      // klient nemusí poznať jeho absolútnu adresu.
      "/api": {
        target: "https://127.0.0.1:4000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});

import fs from "fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // React plugin zabezpečí spracovanie JSX a TSX súborov počas vývoja
  // aj pri produkčnom build procese klienta.
  plugins: [react()],

  server: {
    // Frontend beží cez HTTPS, aby sa správal rovnako ako zvyšok riešenia
    // a nevznikali problémy s bezpečnostnými obmedzeniami prehliadača.
    https: {
      key: fs.readFileSync("../server/tls/key.pem"),
      cert: fs.readFileSync("../server/tls/cert.pem"),
    },
    port: 5173,
    proxy: {
      // Všetky volania na `/api` vo vývojovom režime presmerujeme na backend,
      // aby frontend mohol používať jednoduché relatívne adresy.
      "/api": {
        target: "https://127.0.0.1:4000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Toto je vstupný bod raspberry klienta. React aplikáciu pripojíme do
// elementu `root`, pripraveného v súbore `index.html`.
createRoot(document.getElementById("root")!).render(<App />);

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Toto je vstupný bod klienta. React aplikáciu pripojíme do elementu
// `root`, ktorý je pripravený v súbore `index.html`, a odtiaľ sa ďalej
// vyrenderuje celá používateľská časť systému.
createRoot(document.getElementById("root")!).render(<App />);

import React from "react";
import { BrowserRouter as Router, Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";

export default function App() {
  return (
    // Router zabezpečuje klientsku navigáciu medzi obrazovkami bez toho,
    // aby sa po každom kliknutí znovu načítala celá stránka.
    <Router>
      <Routes>
        {/* Úvodná trasa zobrazí prihlasovaciu a registračnú obrazovku. */}
        <Route path="/" element={<Login />} />

        <Route
          path="/dashboard"
          element={
            // Dashboard sprístupníme až po úspešnej autentifikácii, takže
            // ho obaľujeme ochrannou routou.
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        {/* Každú neznámu adresu presmerujeme späť na začiatok aplikácie. */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

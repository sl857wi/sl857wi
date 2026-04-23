import React from "react";
import { Navigate } from "react-router-dom";

export default function ProtectedRoute({ children }: { children: JSX.Element }) {
  // Finálny token sa uloží do `localStorage` až po úspešnom dokončení
  // heslovej časti aj druhého faktora.
  const token = localStorage.getItem("token");

  // Ak token chýba, používateľ ešte nemá prístup do chránenej časti aplikácie.
  if (!token) return <Navigate to="/" replace />;

  // V opačnom prípade zobrazíme odovzdaný chránený obsah.
  return children;
}

import React from "react";
import { Navigate } from "react-router-dom";

export default function ProtectedRoute({ children }: { children: JSX.Element }) {
  // Finálny token sa uloží do `localStorage` až po úspešnom dokončení
  // heslovej časti aj postkvantového druhého faktora.
  const token = localStorage.getItem("token");

  // Ak token chýba, používateľ ešte nie je považovaný za autentifikovaného
  // a do chránenej časti aplikácie ho nepustíme.
  if (!token) return <Navigate to="/" replace />;

  // V opačnom prípade zobrazíme chránený obsah odovzdaný do tejto obálky.
  return children;
}

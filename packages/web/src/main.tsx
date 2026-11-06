import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./frame.css";
import "./styles.css";
import "./parts.css";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("The page is missing its #root element.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

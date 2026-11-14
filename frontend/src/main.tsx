import React from "react";
import ReactDOM from "react-dom/client";
import { GrowthApp } from "./growth/GrowthApp";
import { ErrorBoundary } from "./components/ui";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <GrowthApp />
    </ErrorBoundary>
  </React.StrictMode>,
);

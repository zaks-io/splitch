import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";

const deploymentUrl = import.meta.env.VITE_CONVEX_URL;
if (!deploymentUrl) throw new Error("CONVEX_URL is required to run the React dogfood app");
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");

const convex = new ConvexReactClient(deploymentUrl);
createRoot(root).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);

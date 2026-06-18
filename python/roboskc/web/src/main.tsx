import { render } from "solid-js/web";

import { App } from "./App";
import "./styles/index.css";

const root = document.getElementById("app");
if (!root) {
  throw new Error("roboskc dashboard: #app mount node missing");
}

render(() => <App />, root);

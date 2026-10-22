import React from "react";
import ReactDOM from "react-dom/client";
import App from "./views/App";
import "./styles/global.css";
import "./styles/app.css";

// StrictMode 在开发时会双次执行 effect，导致拓扑枚举重复调用；
// 这里照常启用，因为相关逻辑都做了幂等处理，且能更早暴露副作用问题。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

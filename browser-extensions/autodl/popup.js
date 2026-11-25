const status = document.getElementById("status");
const labels = {
  connected: "已与画布连接。",
  disconnected: "尚未连接画布。",
  "pair-again": "连接已失效，请在画布上重新连接。",
  waiting: "正在等待本机画布。请保持软件打开。",
};

chrome.runtime.sendMessage({ action: "read" }).then(result => {
  status.textContent = labels[result?.connection] ?? labels.disconnected;
}, () => { status.textContent = "无法读取扩展状态，请重新打开。"; });

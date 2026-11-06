TabAgent v{{VERSION}}

## 更新内容

{{CHANGES}}

## 安装与更新

下载对应浏览器的 `tabagent-{{VERSION}}-*.zip`，不要选 GitHub 自动生成的 `Source code`。

- Chrome：解压 Chrome 包，在 `chrome://extensions` 开启开发者模式，加载含 `manifest.json` 的目录。
- Edge：解压 Edge 包，在 `edge://extensions` 开启开发人员模式并加载解压目录。
- Firefox：本包未签名，仅供临时测试。在 `about:debugging#/runtime/this-firefox` 临时加载 `manifest.json`，重启后需重新加载。
- 已有开发版可覆盖原扩展目录后重新加载，保留原目录和扩展身份。

首次使用请在设置中选择模型服务，填写 Key 和支持工具调用的模型。图片识别需模型支持图片输入，并在设置中开启。模型服务可能收取调用费用。

PDF 全文读取仅支持 Chrome / Edge 的在线文字文件（20 MB、300 页以内），暂不支持扫描、加密、本地 PDF 或 Firefox 内置阅读器。

## 验证

{{CHECKS}}

三浏览器 ZIP 已检查文件完整性。Edge、Firefox 的构建通过不代表已在相应浏览器中完成交互回归。
附件 `INSTALL.txt` 为安装说明，`SHA256SUMS.txt` 为下载校验值。

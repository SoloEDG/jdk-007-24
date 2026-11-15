# 夜航音乐工作室

安装：`npm install`

本地启动：`npm run dev`，访问终端显示的地址。

Docker 启动：`docker compose up --build -d`，访问 http://localhost:18027 。

## 崩溃恢复草稿

页面会持续把当前作品写成一份自动草稿。即使录音没完成就关掉页面，重新打开时也能选择恢复或丢弃：

- **持续保留**：已完成的作品、混音状态、当前录音进度都会随草稿写入；页面隐藏或关闭前会再做一次同步写入。
- **事务写入**：草稿使用两个槽位交替写入——先写未被引用的槽位、回读校验，最后才切换指针。写入中断或空间不足时，上一个可校验版本仍完整保留，不会出现“半条新轨覆盖旧录音”。
- **进行中的按键**：保存时会把仍按下的音符结束在最后可靠拍位，不会留下超出进度的悬空音符。
- **恢复后先暂停**：重新打开不会自动播放，也不会补播关闭期间的音符。音频锚点重新建立，只保留音乐位置。
- **确认后继续**：恢复对话框会并排显示原完整片段与恢复草稿；确认接管后从停止的拍位继续录剩余拍数，丢弃则只清除草稿，原完整录音不受影响。
- **旧格式**：旧版草稿会自动升级；升级失败时不会删除原始数据，并会明确提示。手动存档（顶部“保存作品”/“恢复”）与草稿完全独立，互不覆盖。
- **多窗口**：同一段录音事务只允许一个窗口接管（Web Locks + 带过期时间的租约）。另一个窗口只能丢弃自己的提示，不会破坏对方正在进行的录音。
- **空间不足**：会保留最后一个可校验版本，并在界面顶部提示，同时显示最近可用的修订号。

## 本地验证

`npm run typecheck` 做类型检查。测试用 esbuild 把 TypeScript 打成 Node 可执行模块后运行（无需浏览器）：

```sh
npx esbuild test/persistence.test.mjs --bundle --platform=node --format=esm --alias:@=./src --external:node:* --outfile=/tmp/p.mjs && node /tmp/p.mjs
npx esbuild test/recorder.test.mjs   --bundle --platform=node --format=esm --alias:@=./src --external:node:* --outfile=/tmp/r.mjs && node /tmp/r.mjs
npx esbuild test/studio.test.mjs     --bundle --platform=node --format=esm --alias:@=./src --external:node:* --outfile=/tmp/s.mjs && node /tmp/s.mjs
```

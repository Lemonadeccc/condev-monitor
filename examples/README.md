# Example 启动命令

在仓库根目录安装依赖后，每个 `examples` 一级目录都有一条对应命令：

| 目录                 | 根目录命令                         | 启动地址                             |
| -------------------- | ---------------------------------- | ------------------------------------ |
| `aisdk-rag-chatbox`  | `pnpm examples:aisdk-rag-chatbox`  | <http://127.0.0.1:4000>              |
| `animation-fixtures` | `pnpm examples:animation-fixtures` | Lemon 43101、Nico 43102、Salle 43103 |
| `node`               | `pnpm examples:node`               | 暂无可运行项目，命令会说明缺少的内容 |
| `rag`                | `pnpm examples:rag`                | 前端 5181、后端 8000                 |
| `react`              | `pnpm examples:react`              | <http://127.0.0.1:43112>             |
| `vanilla`            | `pnpm examples:vanilla`            | <http://127.0.0.1:43111>             |

多项目目录会并行启动其中的所有项目。`animation-fixtures` 使用 pnpm 的 `--parallel` 同时运行三个包；不能改成 `&&`，因为第一个开发服务器不会主动退出，后两个命令将永远无法执行。各命令会先构建对应的本地 SDK，再启动示例。

这些根命令不会创建或修改任何 `.env`；Vite、Next.js 和 Docker Compose 仍会依照各项目原有配置加载它们自己的环境文件。

`rag` 后端仍使用项目现有的 Docker Compose 配置及其既有配置要求；AI RAG Chatbox 的完整业务功能也仍需要项目原有的外部服务配置。

`vanilla` 源码当前仍使用它既有的固定上报地址；启动器不会替换或关闭它。是否调整该示例的上报策略应作为单独的 SDK 接入改动处理。

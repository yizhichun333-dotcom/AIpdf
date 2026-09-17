// 从electron模块导入：dialog系统对话框、ipcMain主进程IPC通信对象
import { dialog, ipcMain } from 'electron'
// 导入node的fs/promises，使用异步readFile读取本地文件
import { readFile } from 'node:fs/promises'
// 导入node的path模块basename，用于从完整路径提取文件名
import { basename } from 'node:path'

// 导出注册文档IPC处理器的函数，main.ts中调用
export function registerDocumentIpc(): void {
  // 注册IPC处理函数，监听渲染进程的 document:open-dialog 调用
  ipcMain.handle('document:open-dialog', async () => {
    // 弹出系统文件选择对话框，等待用户操作完成
    const result = await dialog.showOpenDialog({
      title: '选择 PDF', // 文件选择窗口标题
      properties: ['openFile'], // 模式：仅选择单个文件
      filters: [ // 文件过滤，只显示pdf后缀文件
        {
          name: 'PDF Files', // 过滤器显示名称
          extensions: ['pdf'] // 允许的文件后缀，不带小数点
        }
      ]
    })

    // 用户点击取消，或者没有选中任何文件
    if (result.canceled || result.filePaths.length === 0) {
      return null // 返回null通知渲染进程取消操作
    }

    // 获取选中PDF文件的本地绝对路径
    const filePath = result.filePaths[0]
    // 异步读取文件，返回Buffer二进制文件数据
    const buffer = await readFile(filePath)

    // 返回给渲染进程的对象
    return {
      filePath, // 文件完整绝对路径
      fileName: basename(filePath), // 提取纯文件名（例如 demo.pdf）
      data: new Uint8Array(buffer) // 将Buffer转为Uint8Array，供前端pdfjs解析使用
    }
  })
}

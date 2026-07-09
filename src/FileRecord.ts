import { join, parse } from 'path'
import { promises as fs } from 'fs'
import { Context, Session } from 'koishi'

const FILE_TYPES = ['.zip', '.log', '.txt', '.json', '.gz', '.xz']
const TARGET_GROUPS = ['666546887', '978054335', '958853931']

export class FileRecord {
  private recordFolder: string
  private statePath: string
  private activeFiles: Record<string, Record<string, [string, number]>> = {}
  private queues: Map<string, Promise<void>> = new Map()

  constructor(private context: Context, private validate: (session: Session, groups: string[], admin?: boolean) => boolean, private timeout: number) {
    const folderPath = join(context.baseDir, 'data', 'group-mc')
    this.recordFolder = join(folderPath, 'logs')
    this.statePath = join(folderPath, 'logs.json')

    fs.readFile(this.statePath, 'utf-8')
      .then((data) => { this.activeFiles = JSON.parse(data) || {} })
      .catch((error: any) => { if (error.code !== 'ENOENT') this.context.logger.error('初始化失败:', error) })
  }

  private async saveState(): Promise<void> {
    try {
      await fs.mkdir(parse(this.statePath).dir, { recursive: true })
      await fs.writeFile(this.statePath, JSON.stringify(this.activeFiles, null, 2))
    } catch (error: any) {
      this.context.logger.error('保存记录失败:', error)
    }
  }

  async receiveFile(element: any, session: Session): Promise<void> {
    if (!this.validate(session, TARGET_GROUPS)) return
    const { channelId, userId, messageId } = session
    let fileInfo: { name: string; size: number; url: string } | null = null
    const sourceMessage = await session.bot.internal.getMsg(messageId).catch(() => null)
    const messageData = sourceMessage && Array.isArray(sourceMessage.message) ? sourceMessage.message.find((node: any) => node.type === 'file')?.data : null
    if (messageData?.file && messageData.file_size && messageData.url) {
      fileInfo = { name: messageData.file, size: parseInt(messageData.file_size, 10), url: messageData.url }
    } else {
      const { file, 'file-size': attrSize, src } = element.attrs
      if (file && attrSize && src) fileInfo = { name: file, size: parseInt(attrSize, 10), url: src }
    }
    if (!fileInfo || fileInfo.size > 16 * 1024 * 1024 || !FILE_TYPES.some(ext => fileInfo!.name.toLowerCase().endsWith(ext))) return
    const currentTime = Date.now()
    if (!this.activeFiles[channelId!]) this.activeFiles[channelId!] = {}
    const dateString = new Date().toISOString().slice(0, 10)
    let recordId = join(dateString, fileInfo.name)
    const fullPath = join(this.recordFolder, recordId)
    if (await fs.access(fullPath).then(() => true).catch(() => false)) {
      const { name: baseName, ext: extension } = parse(fileInfo.name)
      recordId = join(dateString, `${baseName}_${currentTime}${extension}`)
    }
    try {
      const jsonPath = join(this.recordFolder, `${recordId}.json`)
      await fs.mkdir(parse(jsonPath).dir, { recursive: true })
      await fs.writeFile(jsonPath, JSON.stringify({ recordId, uploaderId: userId, messages: [] as { content: string; userId: string }[] }, null, 2))
      const buffer = await this.context.http.get<ArrayBuffer>(fileInfo.url, { responseType: 'arraybuffer' })
      await fs.writeFile(join(this.recordFolder, recordId), Buffer.from(buffer))
      this.activeFiles[channelId!][userId!] = [recordId, currentTime]
      await this.saveState()
    } catch (error: any) {
      this.context.logger.error(`文件下载失败: ${fileInfo.name}`, error)
    }
  }

  async receiveMessage(session: Session): Promise<void> {
    const fileElement = session.elements?.find(element => element.type === 'file')
    if (fileElement) await this.receiveFile(fileElement, session)
    if (!this.validate(session, TARGET_GROUPS)) return
    const { channelId, userId } = session
    const currentTime = Date.now()
    const channelData = this.activeFiles[channelId!] || {}
    const referenceId = session.elements?.find(el => el.type === 'at')?.attrs?.id ?? (session.event as any).message?.quote?.user?.id
    let targets: { recordId: string; uploaderId: string }[] = []
    if (referenceId && channelData[referenceId]) {
      targets = [{ recordId: channelData[referenceId][0], uploaderId: referenceId }]
    } else if (this.validate(session, TARGET_GROUPS, true)) {
      targets = Object.entries(channelData)
        .filter(([, info]) => currentTime - info[1] <= this.timeout * 60000)
        .map(([uId, info]) => ({ recordId: info[0], uploaderId: uId }))
    } else if (channelData[userId!] && currentTime - channelData[userId!][1] <= this.timeout * 5 * 60000) {
      targets = [{ recordId: channelData[userId!][0], uploaderId: userId! }]
    }
    if (!targets.length) return
    const textParts: string[] = []
    let hasMeaningfulContent = false
    for (const el of session.elements || []) {
      if (el.type === 'text' && el.attrs.content?.trim()) {
        textParts.push(el.attrs.content.trim())
        hasMeaningfulContent = true
      } else if (el.type === 'img' && el.attrs.summary !== '[动画表情]') {
        textParts.push(`[图片: ${el.attrs.src || el.attrs.url}]`)
        hasMeaningfulContent = true
      }
    }
    if (!hasMeaningfulContent) return
    const finalContent = (targets.length > 1 ? '[交叉对话] ' : '') + textParts.join(' ')
    for (const target of targets) {
      const targetPath = join(this.recordFolder, `${target.recordId}.json`)
      const previous = this.queues.get(target.recordId) || Promise.resolve()
      const current = (async () => {
        try {
          await previous
          const data = await fs.readFile(targetPath, 'utf-8')
          const json = JSON.parse(data)
          json.messages.push({ content: finalContent, userId: userId! })
          await fs.writeFile(targetPath, JSON.stringify(json, null, 2))
          const activeData = this.activeFiles[channelId!]?.[target.uploaderId]
          if (activeData && activeData[0] === target.recordId) {
            activeData[1] = currentTime
            await this.saveState()
          }
        } catch (error: any) {
          if (error.code !== 'ENOENT') this.context.logger.error(`追加消息失败: ${target.recordId}`, error)
        }
      })().finally(() => { if (this.queues.get(target.recordId) === current) this.queues.delete(target.recordId) })
      this.queues.set(target.recordId, current)
      await current
    }
  }
}

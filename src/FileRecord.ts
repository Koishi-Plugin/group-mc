import { join, parse } from 'path'
import { promises as fs } from 'fs'
import { Context, Session } from 'koishi'

interface MessageRecord {
  content: string
  userId: string
}

interface FileTarget {
  recordId: string
  uploaderId: string
}

interface ActiveFile {
  recordId: string
  timestamp: number
}

interface RecordState {
  fileIndex: Record<string, string>
  activeFiles: Record<string, Record<string, ActiveFile>>
}

const FILE_TYPES = ['.zip', '.log', '.txt', '.json', '.gz', '.xz']
const IMAGE_TYPES = ['.jpg', '.jpeg', '.png']
const CROSSTALK_TAG = '[交叉对话] '

export class FileRecord {
  private recordFolder: string
  private statePath: string
  private fileIndex: Record<string, string> = {}
  private activeFiles: Record<string, Record<string, ActiveFile>> = {}
  private targetGroups: string[] = ['666546887', '978054335', '958853931']
  private adminList: { userId: string; nickname?: string }[] = []

  constructor(private context: Context) {
    const folderPath = join(context.baseDir, 'data', 'group-mc')
    this.recordFolder = join(folderPath, 'logs')
    this.statePath = join(folderPath, 'logs_state.json')
    this.loadState()
  }

  private async loadState(): Promise<void> {
    try {
      const fileData = await fs.readFile(this.statePath, 'utf-8')
      const stateData = JSON.parse(fileData) as RecordState
      this.fileIndex = stateData.fileIndex || {}
      this.activeFiles = stateData.activeFiles || {}
    } catch (error: any) {
      if (error.code !== 'ENOENT') this.context.logger.error('初始化文件记录状态失败:', error)
      this.fileIndex = {}
      this.activeFiles = {}
    }
  }

  private async saveState(): Promise<void> {
    const { statePath, fileIndex, activeFiles } = this
    await fs.mkdir(parse(statePath).dir, { recursive: true })
    await fs.writeFile(statePath, JSON.stringify({ fileIndex, activeFiles } as RecordState, null, 2))
  }

  async receiveFile(element: any, session: Session): Promise<void> {
    const { channelId, userId, messageId } = session
    const { targetGroups } = this
    if (!channelId || !userId || !targetGroups.includes(channelId)) return

    let fileInfo: { name: string; size: number; url: string } | null = null
    const sourceMessage = await session.bot.internal.getMsg(messageId).catch(() => null)
    const messageData = sourceMessage && Array.isArray(sourceMessage.message)
      ? sourceMessage.message.find((node: any) => node.type === 'file')?.data
      : null

    if (messageData?.file && messageData.file_size && messageData.url) {
      fileInfo = { name: messageData.file, size: parseInt(messageData.file_size, 10), url: messageData.url }
    } else {
      const { file, 'file-size': attrSize, src } = element.attrs
      if (file && attrSize && src) fileInfo = { name: file, size: parseInt(attrSize, 10), url: src }
    }

    if (fileInfo) await this.downloadFile(fileInfo.name, fileInfo.size, fileInfo.url, channelId, userId)
  }

  async receiveMessage(session: Session): Promise<void> {
    const fileElement = session.elements?.find(element => element.type === 'file')
    if (fileElement) {
      await this.receiveFile(fileElement, session)
    }

    const { channelId, userId } = session
    const { targetGroups, activeFiles } = this
    if (!channelId || !userId || !targetGroups.includes(channelId)) return

    const matchedTargets = this.findTargets(channelId, userId, session)
    if (!matchedTargets.length) return

    const messageContent = await this.buildContent(session, matchedTargets[0].recordId)
    if (!messageContent) return

    const finalContent = (matchedTargets.length > 1 ? CROSSTALK_TAG : '') + messageContent
    const currentTime = Date.now()
    let dataChanged = false

    for (const target of matchedTargets) {
      await this.appendMessage(target.recordId, { content: finalContent, userId })
      const activeData = activeFiles[channelId]?.[target.uploaderId]
      if (activeData && activeData.recordId === target.recordId) {
        activeData.timestamp = currentTime
        dataChanged = true
      }
    }

    if (dataChanged) await this.saveState()
  }

  private findTargets(channelId: string, userId: string, session: Session): FileTarget[] {
    const { activeFiles, adminList } = this
    const currentTime = Date.now()
    const referenceId = session.elements?.find(element => element.type === 'at')?.attrs?.id
      ?? (session.event as any).message?.quote?.user?.id
      ?? null
    const channelData = activeFiles[channelId] || {}

    if (referenceId) {
      const infoData = channelData[referenceId]
      return infoData ? [{ recordId: infoData.recordId, uploaderId: referenceId }] : []
    }

    if (adminList.some(admin => admin.userId === userId)) {
      return Object.entries(channelData)
        .filter(([, infoData]) => currentTime - infoData.timestamp <= 2 * 60 * 1000)
        .map(([uploaderId, infoData]) => ({ recordId: infoData.recordId, uploaderId }))
    }

    const selfData = channelData[userId]
    if (selfData && currentTime - selfData.timestamp <= 10 * 60 * 1000) {
      return [{ recordId: selfData.recordId, uploaderId: userId }]
    }
    return []
  }

  private async downloadFile(fileName: string, fileSize: number, fileUrl: string, channelId: string, userId: string): Promise<void> {
    if (fileSize > 16 * 1024 * 1024 || !FILE_TYPES.some(extension => fileName.toLowerCase().endsWith(extension))) return

    const { activeFiles, fileIndex, recordFolder } = this
    const fileKey = `${fileName}_${fileSize}`
    const currentTime = Date.now()
    if (!activeFiles[channelId]) activeFiles[channelId] = {}

    const targetPath = join(recordFolder, `${fileIndex[fileKey]}.json`)
    const fileExists = await fs.access(targetPath).then(() => true).catch(() => false)

    if (fileIndex[fileKey] && fileExists) {
      activeFiles[channelId][userId] = { recordId: fileIndex[fileKey], timestamp: currentTime }
      await this.saveState()
      return
    }

    const recordId = await this.createRecord(fileName, userId)
    fileIndex[fileKey] = recordId
    activeFiles[channelId][userId] = { recordId, timestamp: currentTime }

    const downloadPath = join(recordFolder, recordId)
    await fs.mkdir(parse(downloadPath).dir, { recursive: true })
    const fetchResponse = await this.context.http.get<ArrayBuffer>(fileUrl, { responseType: 'arraybuffer' })
    await fs.writeFile(downloadPath, Buffer.from(fetchResponse))

    await this.saveState()
  }

  private async buildContent(session: Session, recordId: string): Promise<string | null> {
    const { recordFolder } = this
    const textParts: string[] = []
    let hasContent = false

    for (const element of session.elements || []) {
      if (element.type === 'text') {
        const textValue = element.attrs.content?.trim()
        if (textValue) {
          textParts.push(textValue)
          hasContent = true
        }
      } else if (element.type === 'img') {
        if (element.attrs.summary === '[动画表情]') continue
        const imageName = element.attrs.file || `image_${Date.now()}.jpg`
        if (!IMAGE_TYPES.some(extension => imageName.toLowerCase().endsWith(extension))) continue

        hasContent = true
        const uniqueName = `${parse(recordId).name}-${imageName}`
        const imagePath = join(recordFolder, parse(recordId).dir, uniqueName)
        await fs.mkdir(parse(imagePath).dir, { recursive: true })

        const fetchResponse = await this.context.http.get<ArrayBuffer>(element.attrs.src, { responseType: 'arraybuffer' })
        await fs.writeFile(imagePath, Buffer.from(fetchResponse))
        textParts.push(`[图片: ${uniqueName}]`)
      }
    }
    return hasContent ? textParts.join(' ') : null
  }

  private async createRecord(fileName: string, uploaderId: string): Promise<string> {
    const { recordFolder } = this
    const dateString = new Date().toISOString().slice(0, 10)
    const { name: baseName, ext: extension } = parse(fileName)
    let copyCount = 1
    let recordId = join(dateString, fileName)

    while (await fs.access(join(recordFolder, `${recordId}.json`)).then(() => true).catch(() => false)) {
      recordId = join(dateString, `${baseName}(${copyCount})${extension}`)
      copyCount++
    }

    const finalPath = join(recordFolder, `${recordId}.json`)
    await fs.mkdir(parse(finalPath).dir, { recursive: true })
    await fs.writeFile(finalPath, JSON.stringify({ recordId, uploaderId, messages: [] as MessageRecord[] }, null, 2))
    return recordId
  }

  private async appendMessage(recordId: string, messageRecord: MessageRecord): Promise<void> {
    const { recordFolder } = this
    const targetPath = join(recordFolder, `${recordId}.json`)
    try {
      const fileData = await fs.readFile(targetPath, 'utf-8')
      const jsonRecord = JSON.parse(fileData)
      if (jsonRecord) {
        jsonRecord.messages.push(messageRecord)
        await fs.writeFile(targetPath, JSON.stringify(jsonRecord, null, 2))
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') this.context.logger.error(`无法向记录文件添加消息:`, error)
    }
  }
}

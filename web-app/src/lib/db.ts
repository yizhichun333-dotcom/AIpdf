import type { Annotation, ChatMessage, RagIndex, StoredDocument } from './types'

const DB_NAME = 'aipdf-web'
const DB_VERSION = 1
const STORES = {
  documents: 'documents',
  conversations: 'conversations',
  annotations: 'annotations',
  ragIndexes: 'ragIndexes'
} as const

interface ConversationRecord {
  fileHash: string
  messages: ChatMessage[]
  updatedAt: number
}

interface AnnotationRecord {
  id: string
  fileHash: string
  annotation: Annotation
}

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORES.documents)) {
        database.createObjectStore(STORES.documents, { keyPath: 'fileHash' })
      }
      if (!database.objectStoreNames.contains(STORES.conversations)) {
        database.createObjectStore(STORES.conversations, { keyPath: 'fileHash' })
      }
      if (!database.objectStoreNames.contains(STORES.annotations)) {
        const store = database.createObjectStore(STORES.annotations, { keyPath: 'id' })
        store.createIndex('fileHash', 'fileHash', { unique: false })
      }
      if (!database.objectStoreNames.contains(STORES.ragIndexes)) {
        database.createObjectStore(STORES.ragIndexes, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
  })

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })

export const saveDocument = async (document: StoredDocument): Promise<void> => {
  const database = await openDatabase()
  const transaction = database.transaction(STORES.documents, 'readwrite')
  transaction.objectStore(STORES.documents).put(document)
  await transactionDone(transaction)
  database.close()
}

export const getDocument = async (fileHash: string): Promise<StoredDocument | undefined> => {
  const database = await openDatabase()
  const result = await requestToPromise(
    database.transaction(STORES.documents).objectStore(STORES.documents).get(fileHash)
  )
  database.close()
  return result as StoredDocument | undefined
}

export const listDocuments = async (): Promise<StoredDocument[]> => {
  const database = await openDatabase()
  const result = await requestToPromise(
    database.transaction(STORES.documents).objectStore(STORES.documents).getAll()
  )
  database.close()
  return (result as StoredDocument[]).sort((left, right) => right.updatedAt - left.updatedAt)
}

export const deleteDocument = async (fileHash: string): Promise<void> => {
  const database = await openDatabase()
  const transaction = database.transaction(
    [STORES.documents, STORES.conversations, STORES.annotations, STORES.ragIndexes],
    'readwrite'
  )
  transaction.objectStore(STORES.documents).delete(fileHash)
  transaction.objectStore(STORES.conversations).delete(fileHash)

  const annotationCursor = transaction
    .objectStore(STORES.annotations)
    .index('fileHash')
    .openCursor(IDBKeyRange.only(fileHash))
  annotationCursor.onsuccess = () => {
    const cursor = annotationCursor.result
    if (!cursor) return
    cursor.delete()
    cursor.continue()
  }

  const ragCursor = transaction.objectStore(STORES.ragIndexes).openCursor()
  ragCursor.onsuccess = () => {
    const cursor = ragCursor.result
    if (!cursor) return
    if ((cursor.value as RagIndex).fileHash === fileHash) cursor.delete()
    cursor.continue()
  }
  await transactionDone(transaction)
  database.close()
}

export const saveConversation = async (
  fileHash: string,
  messages: ChatMessage[]
): Promise<void> => {
  const database = await openDatabase()
  const transaction = database.transaction(STORES.conversations, 'readwrite')
  transaction.objectStore(STORES.conversations).put({
    fileHash,
    messages,
    updatedAt: Date.now()
  } satisfies ConversationRecord)
  await transactionDone(transaction)
  database.close()
}

export const getConversation = async (fileHash: string): Promise<ChatMessage[]> => {
  const database = await openDatabase()
  const result = await requestToPromise(
    database.transaction(STORES.conversations).objectStore(STORES.conversations).get(fileHash)
  )
  database.close()
  return (result as ConversationRecord | undefined)?.messages ?? []
}

export const saveAnnotation = async (annotation: Annotation): Promise<void> => {
  const database = await openDatabase()
  const transaction = database.transaction(STORES.annotations, 'readwrite')
  transaction.objectStore(STORES.annotations).put({
    id: annotation.id,
    fileHash: annotation.fileHash,
    annotation
  } satisfies AnnotationRecord)
  await transactionDone(transaction)
  database.close()
}

export const getAnnotations = async (fileHash: string): Promise<Annotation[]> => {
  const database = await openDatabase()
  const result = await requestToPromise(
    database
      .transaction(STORES.annotations)
      .objectStore(STORES.annotations)
      .index('fileHash')
      .getAll(IDBKeyRange.only(fileHash))
  )
  database.close()
  return (result as AnnotationRecord[]).map((record) => record.annotation)
}

export const saveRagIndex = async (index: RagIndex): Promise<void> => {
  const database = await openDatabase()
  const transaction = database.transaction(STORES.ragIndexes, 'readwrite')
  transaction.objectStore(STORES.ragIndexes).put(index)
  await transactionDone(transaction)
  database.close()
}

export const getRagIndex = async (fileHash: string): Promise<RagIndex | undefined> => {
  const database = await openDatabase()
  const result = await requestToPromise(
    database.transaction(STORES.ragIndexes).objectStore(STORES.ragIndexes).getAll()
  )
  database.close()
  return (result as RagIndex[]).find((index) => index.fileHash === fileHash)
}

export const clearWebStorage = async (): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Could not clear browser storage'))
    request.onblocked = () => reject(new Error('Close other AIpdf tabs and try again'))
  })
}

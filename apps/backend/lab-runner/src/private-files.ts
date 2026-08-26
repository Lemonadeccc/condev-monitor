import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const PRIVATE_DIRECTORY_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

export async function ensurePrivateDirectory(directory: string, recursive = true): Promise<void> {
    await fs.mkdir(directory, { recursive, mode: PRIVATE_DIRECTORY_MODE })
    const stat = await fs.lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Private output path must be a real directory, not a symbolic link')
    }
    // mkdir's mode is filtered by umask and does not tighten a pre-existing directory.
    await fs.chmod(directory, PRIVATE_DIRECTORY_MODE)
}

export async function writePrivateFile(filePath: string, content: Uint8Array | string): Promise<void> {
    const directory = path.dirname(filePath)
    const directoryStat = await fs.lstat(directory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error('Private output parent must be a real directory, not a symbolic link')
    }
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
        handle = await fs.open(temporaryPath, 'wx', PRIVATE_FILE_MODE)
        await handle.writeFile(content)
        // fchmod applies to the opened inode, so a path swap cannot redirect it.
        await handle.chmod(PRIVATE_FILE_MODE)
        await handle.close()
        handle = null
        // Same-directory rename is atomic on supported local filesystems and
        // replaces a destination symlink itself instead of following its target.
        await fs.rename(temporaryPath, filePath)
    } catch (error) {
        await handle?.close().catch(() => undefined)
        await fs.unlink(temporaryPath).catch(() => undefined)
        throw error
    }
}

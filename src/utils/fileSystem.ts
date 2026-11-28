import type { MidiFileEntry } from '../types/midi';

export interface LoadedFolderResult {
  folderName: string;
  rootDirHandle: FileSystemDirectoryHandle | null;
  canWriteToDisk: boolean;
  entries: MidiFileEntry[];
}

export function isMidiFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.mid') || lower.endsWith('.midi');
}

export function isSidecarTxtFilename(name: string): boolean {
  return name.toLowerCase().endsWith('.txt');
}

function getFileStemLower(name: string): string {
  const dotIdx = name.lastIndexOf('.');
  return (dotIdx > 0 ? name.slice(0, dotIdx) : name).toLowerCase();
}

export function canUseNativeDirectoryPicker(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      'showDirectoryPicker' in window &&
      window.self === window.top
    );
  } catch {
    return false;
  }
}

async function scanDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  prefix: string,
  out: MidiFileEntry[]
): Promise<void> {
  const iter = (
    dirHandle as unknown as { values: () => AsyncIterable<FileSystemHandle> }
  ).values();
  const dirMidiEntries: MidiFileEntry[] = [];
  const dirTxtMap = new Map<string, { handle: FileSystemFileHandle; relativePath: string }>();
  const subDirs: Array<{ handle: FileSystemDirectoryHandle; subPrefix: string }> = [];

  for await (const handle of iter) {
    if (handle.kind === 'file') {
      if (isMidiFilename(handle.name)) {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        const relativePath = prefix ? `${prefix}/${handle.name}` : handle.name;
        dirMidiEntries.push({
          id: `${relativePath}::${file.size}::${file.lastModified}`,
          name: handle.name,
          relativePath,
          folderPath: prefix,
          sizeBytes: file.size,
          lastModified: file.lastModified,
          file,
          fileHandle,
          parentDirHandle: dirHandle,
          parsed: null,
          triage: 'pending',
        });
      } else if (isSidecarTxtFilename(handle.name)) {
        const relativePath = prefix ? `${prefix}/${handle.name}` : handle.name;
        dirTxtMap.set(getFileStemLower(handle.name), {
          handle: handle as FileSystemFileHandle,
          relativePath,
        });
      }
    } else if (handle.kind === 'directory') {
      // Skip hidden, trash, or automatic backup folders
      if (
        handle.name.startsWith('.') ||
        handle.name === '_Aussortiert' ||
        handle.name === '_Originale_Backup'
      ) {
        continue;
      }
      const subPrefix = prefix ? `${prefix}/${handle.name}` : handle.name;
      subDirs.push({ handle: handle as FileSystemDirectoryHandle, subPrefix });
    }
  }

  for (const entry of dirMidiEntries) {
    const match = dirTxtMap.get(getFileStemLower(entry.name));
    if (match) {
      entry.sidecarHandle = match.handle;
      entry.sidecarRelativePath = match.relativePath;
    }
    out.push(entry);
  }

  for (const sub of subDirs) {
    await scanDirectoryHandle(sub.handle, sub.subPrefix, out);
  }
}

export async function pickFolderNative(): Promise<LoadedFolderResult> {
  const picker = (window as unknown as {
    showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;

  let canWrite = true;
  let dirHandle: FileSystemDirectoryHandle;

  try {
    dirHandle = await picker({ mode: 'readwrite' });
  } catch (err) {
    // If user cancelled, propagate AbortError immediately
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    // Retry read-only if readwrite wasn't permitted
    dirHandle = await picker({ mode: 'read' });
    canWrite = false;
  }

  const entries: MidiFileEntry[] = [];
  await scanDirectoryHandle(dirHandle, '', entries);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'de', { sensitivity: 'base' }));

  return {
    folderName: dirHandle.name,
    rootDirHandle: dirHandle,
    canWriteToDisk: canWrite,
    entries,
  };
}

export function loadFromFileList(fileList: FileList | File[]): LoadedFolderResult {
  const allFiles = Array.from(fileList);
  const midiFiles = allFiles.filter((f) => isMidiFilename(f.name));
  const txtFiles = allFiles.filter((f) => isSidecarTxtFilename(f.name));
  let folderName = 'Ausgewählter Ordner';

  const extractRel = (file: File): { relativePath: string; folderPath: string } => {
    const webkitPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    if (webkitPath) {
      const parts = webkitPath.split('/');
      if (parts.length > 1) {
        folderName = parts[0];
        return {
          relativePath: parts.slice(1).join('/'),
          folderPath: parts.slice(1, -1).join('/'),
        };
      }
    }
    return { relativePath: file.name, folderPath: '' };
  };

  const txtByFolderStem = new Map<string, { file: File; relativePath: string }>();
  for (const tf of txtFiles) {
    const { relativePath, folderPath } = extractRel(tf);
    txtByFolderStem.set(`${folderPath.toLowerCase()}::${getFileStemLower(tf.name)}`, {
      file: tf,
      relativePath,
    });
  }

  const entries: MidiFileEntry[] = midiFiles.map((file) => {
    const { relativePath, folderPath } = extractRel(file);
    const sidecar = txtByFolderStem.get(
      `${folderPath.toLowerCase()}::${getFileStemLower(file.name)}`
    );

    return {
      id: `${relativePath}::${file.size}::${file.lastModified}`,
      name: file.name,
      relativePath,
      folderPath,
      sizeBytes: file.size,
      lastModified: file.lastModified,
      file,
      sidecarFile: sidecar?.file,
      sidecarRelativePath: sidecar?.relativePath,
      parsed: null,
      triage: 'pending',
    };
  });

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'de', { sensitivity: 'base' }));

  return {
    folderName,
    rootDirHandle: null,
    canWriteToDisk: false,
    entries,
  };
}

async function readEntryFiles(
  entry: FileSystemEntry,
  prefix: string,
  outMidi: Array<{ file: File; relativePath: string; folderPath: string }>,
  outTxt: Array<{ file: File; relativePath: string; folderPath: string }>
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    if (isMidiFilename(file.name)) {
      outMidi.push({ file, relativePath, folderPath: prefix });
    } else if (isSidecarTxtFilename(file.name)) {
      outTxt.push({ file, relativePath, folderPath: prefix });
    }
  } else if (entry.isDirectory) {
    if (entry.name === '_Aussortiert' || entry.name === '_Originale_Backup') return;
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const readAllBatch = async (): Promise<FileSystemEntry[]> => {
      const all: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        all.push(...batch);
      } while (batch.length > 0);
      return all;
    };

    const children = await readAllBatch();
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    for (const child of children) {
      await readEntryFiles(child, nextPrefix, outMidi, outTxt);
    }
  }
}

export async function loadFromDataTransfer(dataTransfer: DataTransfer): Promise<LoadedFolderResult> {
  const items = Array.from(dataTransfer.items || []);
  const collectedMidi: Array<{ file: File; relativePath: string; folderPath: string }> = [];
  const collectedTxt: Array<{ file: File; relativePath: string; folderPath: string }> = [];
  let rootFolderName = 'Abgelegte MIDI-Dateien';

  const fsEntries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  if (fsEntries.length > 0) {
    if (fsEntries.length === 1 && fsEntries[0].isDirectory) {
      rootFolderName = fsEntries[0].name;
      const dirEntry = fsEntries[0] as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const children = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      for (const child of children) {
        await readEntryFiles(child, '', collectedMidi, collectedTxt);
      }
    } else {
      for (const entry of fsEntries) {
        await readEntryFiles(entry, '', collectedMidi, collectedTxt);
      }
    }
  } else {
    for (const file of Array.from(dataTransfer.files)) {
      if (isMidiFilename(file.name)) {
        collectedMidi.push({ file, relativePath: file.name, folderPath: '' });
      } else if (isSidecarTxtFilename(file.name)) {
        collectedTxt.push({ file, relativePath: file.name, folderPath: '' });
      }
    }
  }

  const txtMap = new Map<string, { file: File; relativePath: string }>();
  for (const tf of collectedTxt) {
    txtMap.set(`${tf.folderPath.toLowerCase()}::${getFileStemLower(tf.file.name)}`, {
      file: tf.file,
      relativePath: tf.relativePath,
    });
  }

  const entries: MidiFileEntry[] = collectedMidi
    .map(({ file, relativePath, folderPath }) => {
      const sidecar = txtMap.get(
        `${folderPath.toLowerCase()}::${getFileStemLower(file.name)}`
      );
      return {
        id: `${relativePath}::${file.size}::${file.lastModified}`,
        name: file.name,
        relativePath,
        folderPath,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        file,
        sidecarFile: sidecar?.file,
        sidecarRelativePath: sidecar?.relativePath,
        parsed: null,
        triage: 'pending' as const,
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'de', { sensitivity: 'base' }));

  return {
    folderName: rootFolderName,
    rootDirHandle: null,
    canWriteToDisk: false,
    entries,
  };
}

export async function readSidecarText(entry: MidiFileEntry): Promise<string | null> {
  try {
    if (entry.sidecarHandle) {
      const f = await entry.sidecarHandle.getFile();
      return await f.text();
    }
    if (entry.sidecarFile) {
      return await entry.sidecarFile.text();
    }
  } catch {
    // Ignore unreadable sidecar
  }
  return null;
}

export async function moveEntryToSortedFolder(
  rootDir: FileSystemDirectoryHandle,
  entry: MidiFileEntry,
  targetFolderName = '_Aussortiert'
): Promise<void> {
  if (!entry.fileHandle || !entry.parentDirHandle) {
    throw new Error('Kein Schreibzugriff auf das lokale Dateisystem.');
  }
  const targetDir = await rootDir.getDirectoryHandle(targetFolderName, { create: true });
  const sourceFile = await entry.fileHandle.getFile();
  const safeName = entry.folderPath
    ? `${entry.folderPath.replaceAll('/', '__')}__${entry.name}`
    : entry.name;
  const destHandle = await targetDir.getFileHandle(safeName, { create: true });
  const writable = await destHandle.createWritable();
  await writable.write(await sourceFile.arrayBuffer());
  await writable.close();
  await entry.parentDirHandle.removeEntry(entry.name);

  // Also move matching .txt sidecar if present so MIDI and metadata stay paired
  if (entry.sidecarHandle) {
    try {
      const sidecarFile = await entry.sidecarHandle.getFile();
      const safeSidecarName = safeName.replace(/\.(mid|midi)$/i, '.txt');
      const sidecarDest = await targetDir.getFileHandle(safeSidecarName, { create: true });
      const sw = await sidecarDest.createWritable();
      await sw.write(await sidecarFile.arrayBuffer());
      await sw.close();
      await entry.parentDirHandle.removeEntry(entry.sidecarHandle.name);
    } catch {
      // Non-fatal if sidecar was already removed
    }
  }
}

export async function deleteEntryFromDisk(entry: MidiFileEntry): Promise<void> {
  if (!entry.parentDirHandle) {
    throw new Error('Kein Schreibzugriff auf das lokale Dateisystem.');
  }
  await entry.parentDirHandle.removeEntry(entry.name);
}

export function buildCleanupScript(
  entries: MidiFileEntry[],
  format: 'bat' | 'ps1' | 'sh' | 'txt',
  action: 'move' | 'delete'
): string {
  const paths = entries.map((e) => e.relativePath);

  if (format === 'txt') {
    return paths.join('\n') + '\n';
  }

  if (format === 'bat') {
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'echo Starte Bereinigung von ' + paths.length + ' aussortierten MIDI-Dateien...',
    ];
    if (action === 'move') {
      lines.push('if not exist "_Aussortiert" mkdir "_Aussortiert"');
      for (const p of paths) {
        const winPath = p.replaceAll('/', '\\');
        lines.push(`if exist "${winPath}" move /Y "${winPath}" "_Aussortiert\\"`);
      }
    } else {
      for (const p of paths) {
        const winPath = p.replaceAll('/', '\\');
        lines.push(`if exist "${winPath}" del /F /Q "${winPath}"`);
      }
    }
    lines.push('echo Fertig!', 'pause');
    return lines.join('\r\n');
  }

  if (format === 'ps1') {
    const lines = [
      '$ErrorActionPreference = "Continue"',
      `Write-Host "Bearbeite ${paths.length} aussortierte MIDI-Dateien..."`,
    ];
    if (action === 'move') {
      lines.push('New-Item -ItemType Directory -Force -Path "_Aussortiert" | Out-Null');
      for (const p of paths) {
        const winPath = p.replaceAll('/', '\\').replaceAll("'", "''");
        lines.push(`if (Test-Path -LiteralPath '${winPath}') { Move-Item -LiteralPath '${winPath}' -Destination '_Aussortiert' -Force }`);
      }
    } else {
      for (const p of paths) {
        const winPath = p.replaceAll('/', '\\').replaceAll("'", "''");
        lines.push(`if (Test-Path -LiteralPath '${winPath}') { Remove-Item -LiteralPath '${winPath}' -Force }`);
      }
    }
    lines.push('Write-Host "Fertig!"');
    return lines.join('\r\n');
  }

  // POSIX shell (.sh)
  const lines = ['#!/usr/bin/env bash', 'set -e'];
  if (action === 'move') {
    lines.push('mkdir -p "_Aussortiert"');
    for (const p of paths) {
      const escaped = p.replaceAll('"', '\\"');
      lines.push(`[ -f "${escaped}" ] && mv -f "${escaped}" "_Aussortiert/"`);
    }
  } else {
    for (const p of paths) {
      const escaped = p.replaceAll('"', '\\"');
      lines.push(`[ -f "${escaped}" ] && rm -f "${escaped}"`);
    }
  }
  lines.push('echo "Fertig: ' + paths.length + ' Dateien bearbeitet."');
  return lines.join('\n') + '\n';
}

export async function backupOriginalBeforeOverwriteOnDisk(
  rootDir: FileSystemDirectoryHandle,
  entry: MidiFileEntry
): Promise<string> {
  if (!entry.fileHandle) {
    throw new Error('Kein Schreibzugriff auf die lokale Datei.');
  }
  const backupDir = await rootDir.getDirectoryHandle('_Originale_Backup', { create: true });
  const sourceFile = await entry.fileHandle.getFile();
  const baseSafe = entry.folderPath
    ? `${entry.folderPath.replaceAll('/', '__')}__${entry.name}`
    : entry.name;

  const dotIdx = baseSafe.lastIndexOf('.');
  const stem = dotIdx > 0 ? baseSafe.slice(0, dotIdx) : baseSafe;
  const ext = dotIdx > 0 ? baseSafe.slice(dotIdx) : '.mid';

  let candidate = baseSafe;
  let counter = 2;
  while (counter < 100) {
    try {
      await backupDir.getFileHandle(candidate, { create: false });
      candidate = `${stem}_v${counter}${ext}`;
      counter++;
    } catch {
      break;
    }
  }

  const destHandle = await backupDir.getFileHandle(candidate, { create: true });
  const writable = await destHandle.createWritable();
  await writable.write(await sourceFile.arrayBuffer());
  await writable.close();
  return `_Originale_Backup/${candidate}`;
}

export async function overwriteEntryOnDisk(
  entry: MidiFileEntry,
  buffer: ArrayBuffer
): Promise<void> {
  if (!entry.fileHandle) {
    throw new Error('Kein Schreibzugriff auf die lokale Datei.');
  }
  const writable = await entry.fileHandle.createWritable();
  await writable.write(buffer);
  await writable.close();
}

export async function saveTrimmedCopyOnDisk(
  entry: MidiFileEntry,
  buffer: ArrayBuffer,
  suffix = '_trimmed'
): Promise<string> {
  if (!entry.parentDirHandle) {
    throw new Error('Kein Schreibzugriff auf den Zielordner.');
  }
  const dotIdx = entry.name.lastIndexOf('.');
  const base = dotIdx > 0 ? entry.name.slice(0, dotIdx) : entry.name;
  const ext = dotIdx > 0 ? entry.name.slice(dotIdx) : '.mid';

  // Never silently overwrite an existing file when saving a trimmed copy
  let newName = `${base}${suffix}${ext}`;
  let counter = 2;
  while (counter < 100) {
    try {
      await entry.parentDirHandle.getFileHandle(newName, { create: false });
      newName = `${base}${suffix}_${counter}${ext}`;
      counter++;
    } catch {
      break;
    }
  }

  const destHandle = await entry.parentDirHandle.getFileHandle(newName, { create: true });
  const writable = await destHandle.createWritable();
  await writable.write(buffer);
  await writable.close();
  return newName;
}

export function downloadMidiBuffer(filename: string, buffer: ArrayBuffer): void {
  const blob = new Blob([buffer], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function renameEntryOnDisk(
  entry: MidiFileEntry,
  newFilename: string
): Promise<{
  fileHandle: FileSystemFileHandle;
  file: File;
  sidecarHandle?: FileSystemFileHandle;
  sidecarFile?: File;
  sidecarRelativePath?: string;
}> {
  if (!entry.fileHandle || !entry.parentDirHandle) {
    throw new Error('Kein Schreibzugriff auf die lokale Datei.');
  }

  // Prevent accidentally overwriting a different existing file
  if (newFilename.toLowerCase() !== entry.name.toLowerCase()) {
    let exists = false;
    try {
      await entry.parentDirHandle.getFileHandle(newFilename, { create: false });
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(`Eine Datei mit dem Namen „${newFilename}“ existiert bereits.`);
    }
  }

  const movableHandle = entry.fileHandle as FileSystemFileHandle & {
    move?: (newName: string) => Promise<void>;
  };

  let updatedHandle: FileSystemFileHandle;
  let updatedFile: File;

  if (typeof movableHandle.move === 'function') {
    await movableHandle.move(newFilename);
    updatedHandle = await entry.parentDirHandle.getFileHandle(newFilename, { create: false });
    updatedFile = await updatedHandle.getFile();
  } else {
    // Fallback for browsers without FileSystemFileHandle.move()
    const sourceFile = await entry.fileHandle.getFile();
    const data = await sourceFile.arrayBuffer();
    const destHandle = await entry.parentDirHandle.getFileHandle(newFilename, { create: true });
    const writable = await destHandle.createWritable();
    await writable.write(data);
    await writable.close();
    await entry.parentDirHandle.removeEntry(entry.name);
    updatedHandle = destHandle;
    updatedFile = await destHandle.getFile();
  }

  // Rename paired .txt sidecar alongside the MIDI file if it exists
  let nextSidecarHandle: FileSystemFileHandle | undefined;
  let nextSidecarFile: File | undefined;
  let nextSidecarRel: string | undefined;

  if (entry.sidecarHandle) {
    const newSidecarName = newFilename.replace(/\.(mid|midi)$/i, '.txt');
    try {
      const movableSidecar = entry.sidecarHandle as FileSystemFileHandle & {
        move?: (newName: string) => Promise<void>;
      };
      if (typeof movableSidecar.move === 'function') {
        await movableSidecar.move(newSidecarName);
        nextSidecarHandle = await entry.parentDirHandle.getFileHandle(newSidecarName, {
          create: false,
        });
        nextSidecarFile = await nextSidecarHandle.getFile();
      } else {
        const oldTxt = await entry.sidecarHandle.getFile();
        const txtDest = await entry.parentDirHandle.getFileHandle(newSidecarName, {
          create: true,
        });
        const tw = await txtDest.createWritable();
        await tw.write(await oldTxt.arrayBuffer());
        await tw.close();
        await entry.parentDirHandle.removeEntry(entry.sidecarHandle.name);
        nextSidecarHandle = txtDest;
        nextSidecarFile = await txtDest.getFile();
      }
      nextSidecarRel = entry.folderPath
        ? `${entry.folderPath}/${newSidecarName}`
        : newSidecarName;
    } catch {
      // Keep existing handle reference if sidecar move fails
      nextSidecarHandle = entry.sidecarHandle;
      nextSidecarFile = entry.sidecarFile;
      nextSidecarRel = entry.sidecarRelativePath;
    }
  }

  return {
    fileHandle: updatedHandle,
    file: updatedFile,
    sidecarHandle: nextSidecarHandle,
    sidecarFile: nextSidecarFile,
    sidecarRelativePath: nextSidecarRel,
  };
}

export async function saveTextFileOnDisk(
  entry: MidiFileEntry,
  filename: string,
  content: string
): Promise<string> {
  if (!entry.parentDirHandle) {
    throw new Error('Kein Schreibzugriff auf den Zielordner.');
  }
  const destHandle = await entry.parentDirHandle.getFileHandle(filename, { create: true });
  const writable = await destHandle.createWritable();
  await writable.write(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  await writable.close();
  return filename;
}

export async function saveSidecarTxtOnDisk(
  entry: MidiFileEntry,
  content: string
): Promise<{
  filename: string;
  relativePath: string;
  sidecarHandle: FileSystemFileHandle;
  sidecarFile: File;
}> {
  if (!entry.parentDirHandle) {
    throw new Error('Kein Schreibzugriff auf den Zielordner.');
  }
  const filename = entry.name.replace(/\.(mid|midi)$/i, '.txt');
  const destHandle = await entry.parentDirHandle.getFileHandle(filename, { create: true });
  const writable = await destHandle.createWritable();
  await writable.write(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  await writable.close();
  const sidecarFile = await destHandle.getFile();
  const relativePath = entry.folderPath ? `${entry.folderPath}/${filename}` : filename;
  return { filename, relativePath, sidecarHandle: destHandle, sidecarFile };
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}




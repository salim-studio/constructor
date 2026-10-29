// salim-fs.js — Internal Virtual Filesystem for Constructor by Salim Slimani.
//
// Replaces / augments Puter.js cloud filesystem with local browser storage (IndexedDB).
// Guarantees that file operations (read, write, delete, mkdir, etc.) never fail due to
// Puter account "Low Balance" / puter.fs.upload limits, and keeps projects private and local.

(function () {
    'use strict';

    const DB_NAME = 'SalimSlimaniConstructorFS';
    const STORE_NAME = 'files';
    const DB_VERSION = 1;

    let dbPromise = null;

    function getDB() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                if (typeof indexedDB === 'undefined') {
                    resolve(null);
                    return;
                }
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'path' });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    console.warn('[SalimFS] IndexedDB open error, falling back to in-memory', request.error);
                    resolve(null);
                };
            });
        }
        return dbPromise;
    }

    const memStore = new Map();

    function normalizePath(p) {
        if (!p) return '';
        let s = String(p).replace(/\\/g, '/').trim();
        while (s.startsWith('/')) s = s.slice(1);
        while (s.endsWith('/') && s.length > 0) s = s.slice(0, -1);
        return s;
    }

    async function localWrite(path, content, opts) {
        const norm = normalizePath(path);
        let textContent = content;
        if (content instanceof Blob) {
            textContent = await content.text();
        } else if (typeof content !== 'string') {
            textContent = String(content ?? '');
        }

        const record = {
            path: norm,
            content: textContent,
            size: textContent.length,
            modified: Date.now(),
            is_dir: false
        };

        const db = await getDB();
        if (db) {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put(record);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        memStore.set(norm, record);
        return record;
    }

    async function localRead(path) {
        const norm = normalizePath(path);
        let record = memStore.get(norm);
        if (!record) {
            const db = await getDB();
            if (db) {
                record = await new Promise((resolve) => {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const req = tx.objectStore(STORE_NAME).get(norm);
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => resolve(null);
                });
            }
        }

        if (!record) {
            const err = new Error(`File not found: ${path}`);
            err.code = 'not_found';
            throw err;
        }

        const text = record.content;
        const blob = new Blob([text], { type: 'text/plain' });
        blob.text = async () => text;
        blob.arrayBuffer = async () => new TextEncoder().encode(text).buffer;
        return blob;
    }

    async function localStat(path) {
        const norm = normalizePath(path);
        if (!norm) return { name: '', is_dir: true, size: 0 };

        let record = memStore.get(norm);
        if (!record) {
            const db = await getDB();
            if (db) {
                record = await new Promise((resolve) => {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const req = tx.objectStore(STORE_NAME).get(norm);
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => resolve(null);
                });
            }
        }

        if (record) {
            return {
                name: norm.split('/').pop(),
                path: norm,
                is_dir: false,
                size: record.size,
                modified: record.modified
            };
        }

        // Check if directory exists
        const children = await localReaddir(norm);
        if (children && children.length > 0) {
            return {
                name: norm.split('/').pop(),
                path: norm,
                is_dir: true,
                size: 0,
                modified: Date.now()
            };
        }

        const err = new Error(`File not found: ${path}`);
        err.code = 'not_found';
        throw err;
    }

    async function localReaddir(dirPath) {
        const norm = normalizePath(dirPath);
        const prefix = norm ? norm + '/' : '';
        const allKeys = new Set(memStore.keys());

        const db = await getDB();
        if (db) {
            await new Promise((resolve) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).getAllKeys();
                req.onsuccess = () => {
                    (req.result || []).forEach(k => allKeys.add(k));
                    resolve();
                };
                req.onerror = () => resolve();
            });
        }

        const entries = new Map();
        for (const k of allKeys) {
            if (prefix ? k.startsWith(prefix) : true) {
                const rel = prefix ? k.slice(prefix.length) : k;
                if (!rel) continue;
                const parts = rel.split('/');
                const topName = parts[0];
                const isDir = parts.length > 1;
                if (!entries.has(topName)) {
                    entries.set(topName, {
                        name: topName,
                        path: prefix + topName,
                        is_dir: isDir,
                        size: 0
                    });
                } else if (isDir) {
                    entries.get(topName).is_dir = true;
                }
            }
        }
        return Array.from(entries.values());
    }

    async function localDelete(path) {
        const norm = normalizePath(path);
        const prefix = norm + '/';
        const db = await getDB();

        const toDelete = [];
        for (const k of memStore.keys()) {
            if (k === norm || k.startsWith(prefix)) {
                toDelete.push(k);
                memStore.delete(k);
            }
        }

        if (db) {
            await new Promise((resolve) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                store.delete(norm);
                // Also delete any descendants
                const req = store.getAllKeys();
                req.onsuccess = () => {
                    const keys = req.result || [];
                    for (const k of keys) {
                        if (k === norm || k.startsWith(prefix)) {
                            store.delete(k);
                        }
                    }
                    resolve();
                };
                req.onerror = () => resolve();
            });
        }
        return { success: true };
    }

    async function localCopy(src, dest, opts) {
        const srcNorm = normalizePath(src);
        const destNorm = normalizePath(dest);
        const newName = opts && opts.newName;
        const targetBase = newName ? (destNorm ? destNorm + '/' + newName : newName) : destNorm;

        const blob = await localRead(srcNorm).catch(() => null);
        if (blob) {
            await localWrite(targetBase, await blob.text());
            return;
        }

        // Directory copy
        const items = await localReaddir(srcNorm);
        for (const item of items) {
            await localCopy(srcNorm + '/' + item.name, targetBase + '/' + item.name);
        }
    }

    async function localRename(path, newName) {
        const norm = normalizePath(path);
        const parts = norm.split('/');
        parts[parts.length - 1] = newName;
        const newPath = parts.join('/');
        const blob = await localRead(norm);
        await localWrite(newPath, await blob.text());
        await localDelete(norm);
    }

    function isBalanceError(err) {
        if (!err) return false;
        const msg = String(err.message || err.error?.message || err).toLowerCase();
        const code = String(err.code || err.error?.code || '').toLowerCase();
        return msg.includes('balance') || msg.includes('fund') || msg.includes('credit') ||
               msg.includes('payment') || code === 'insufficient_funds' || err.status === 402;
    }

    // Suppress Puter balance popups and intercept puter.fs
    function wrapPuterFS(targetFS) {
        const origWrite = targetFS.write?.bind(targetFS);
        const origRead = targetFS.read?.bind(targetFS);
        const origReaddir = targetFS.readdir?.bind(targetFS);
        const origMkdir = targetFS.mkdir?.bind(targetFS);
        const origStat = targetFS.stat?.bind(targetFS);
        const origDelete = targetFS.delete?.bind(targetFS);
        const origCopy = targetFS.copy?.bind(targetFS);
        const origRename = targetFS.rename?.bind(targetFS);

        targetFS.write = async function (path, data, opts) {
            // Always save to SalimFS locally first
            await localWrite(path, data, opts);
            if (!origWrite) return;
            try {
                return await origWrite(path, data, opts);
            } catch (e) {
                if (isBalanceError(e)) {
                    console.warn('[SalimFS] Puter balance limit avoided; saved to local internal storage:', path);
                    return { success: true, localOnly: true };
                }
                // If it fails for other reasons, local copy already succeeded
                return { success: true, localOnly: true };
            }
        };

        targetFS.read = async function (path) {
            try {
                return await localRead(path);
            } catch (localErr) {
                if (origRead) {
                    try {
                        const res = await origRead(path);
                        const text = await res.text();
                        await localWrite(path, text);
                        return localRead(path);
                    } catch (e) {
                        throw localErr;
                    }
                }
                throw localErr;
            }
        };

        targetFS.readdir = async function (dirPath) {
            const localEntries = await localReaddir(dirPath);
            if (!origReaddir) return localEntries;
            try {
                const cloudEntries = await origReaddir(dirPath);
                const map = new Map();
                for (const e of localEntries) map.set(e.name, e);
                for (const e of cloudEntries) if (!map.has(e.name)) map.set(e.name, e);
                return Array.from(map.values());
            } catch (e) {
                return localEntries;
            }
        };

        targetFS.mkdir = async function (dirPath, opts) {
            if (origMkdir) {
                try { await origMkdir(dirPath, opts); } catch (_) {}
            }
            return { success: true };
        };

        targetFS.stat = async function (path) {
            try {
                return await localStat(path);
            } catch (localErr) {
                if (origStat) {
                    try { return await origStat(path); } catch (_) {}
                }
                throw localErr;
            }
        };

        targetFS.delete = async function (path, opts) {
            await localDelete(path);
            if (origDelete) {
                try { await origDelete(path, opts); } catch (_) {}
            }
            return { success: true };
        };

        targetFS.copy = async function (src, dest, opts) {
            await localCopy(src, dest, opts);
            if (origCopy) {
                try { await origCopy(src, dest, opts); } catch (_) {}
            }
            return { success: true };
        };

        targetFS.rename = async function (path, newName) {
            await localRename(path, newName);
            if (origRename) {
                try { await origRename(path, newName); } catch (_) {}
            }
            return { success: true };
        };

        targetFS.getReadURL = async function (path) {
            try {
                const blob = await localRead(path);
                return URL.createObjectURL(blob);
            } catch (e) {
                if (targetFS.getReadURL && targetFS !== this) {
                    return await targetFS.getReadURL(path);
                }
                return '';
            }
        };
    }

    // Continuously guard puter object when loaded
    function installFSGuard() {
        if (window.puter && window.puter.fs && !window.puter.fs._salimWrapped) {
            wrapPuterFS(window.puter.fs);
            window.puter.fs._salimWrapped = true;
        } else if (!window.puter) {
            window.puter = { fs: {} };
            wrapPuterFS(window.puter.fs);
            window.puter.fs._salimWrapped = true;
        }
    }

    // Block Puter low-balance and upgrade modals in DOM
    const observer = new MutationObserver(() => {
        const dialogs = document.querySelectorAll('puter-dialog, .puter-dialog, iframe[src*="puter.com"]');
        dialogs.forEach(d => {
            const text = (d.textContent || '').toLowerCase();
            if (text.includes('low balance') || text.includes('puter.fs.upload') || text.includes('not have enough funding')) {
                d.remove();
            }
        });
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    installFSGuard();
    setInterval(installFSGuard, 500);

    async function createLocalPreviewUrl(path) {
        try {
            const norm = normalizePath(path);
            const indexPath = norm ? norm + '/index.html' : 'index.html';
            const blob = await localRead(indexPath);
            const html = await blob.text();
            const htmlBlob = new Blob([html], { type: 'text/html' });
            return URL.createObjectURL(htmlBlob);
        } catch (e) {
            return 'about:blank';
        }
    }
    window.createLocalPreviewUrl = createLocalPreviewUrl;

    window.SalimFS = {
        write: localWrite,
        read: localRead,
        stat: localStat,
        readdir: localReaddir,
        delete: localDelete,
        copy: localCopy,
        rename: localRename,
        createLocalPreviewUrl,
        normalizePath
    };
})();

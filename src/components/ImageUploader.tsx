'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UploadOutcome, UploadRefusal } from '@/lib/upload';

/** The server's limit, MAX_IMAGE_BYTES; checked here too so a huge file is never sent. */
const MAX_BYTES = 30 * 1024 * 1024;

interface Picked {
  file: File;
  operation: string;
  name: string;
}

interface Plan {
  folder: string;
  images: Picked[];
  operations: [string, number][];
  notImages: number;
  practice: number;
}

type Result = UploadOutcome | { kind: 'failed'; signedOut: boolean };

const IMAGE = /\.(png|jpe?g)$/i;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const PARALLEL = 3;

const REFUSAL_TEXT: Record<UploadRefusal, string> = {
  empty: 'empty file',
  too_large: 'larger than 30 MB',
  not_an_image: 'not a readable PNG or JPEG',
  no_operation: 'no folder name to use as the operation',
  practice: 'in a folder called practice',
  disk_full: 'the server’s disk is nearly full',
};

/**
 * Reads a chosen folder: each image's operation is the folder it sits in, so
 * choosing a folder of operation folders, or a single operation's folder,
 * both do the right thing.
 */
function planFrom(files: FileList): Plan {
  const images: Picked[] = [];
  const counts = new Map<string, number>();
  let notImages = 0;
  let practice = 0;
  let folder = '';
  for (const file of Array.from(files)) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    const name = parts[parts.length - 1];
    folder ||= parts.length > 1 ? parts[0] : '';
    if (name.startsWith('.')) continue;
    if (!IMAGE.test(name)) {
      notImages++;
      continue;
    }
    const operation = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (operation.trim().toLowerCase() === 'practice') {
      practice++;
      continue;
    }
    images.push({ file, operation, name });
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
  }
  images.sort((a, b) =>
    a.operation === b.operation
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.operation.localeCompare(b.operation, undefined, { numeric: true }),
  );
  const operations = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return { folder, images, operations, notImages, practice };
}

async function uploadOne(image: Picked): Promise<Result> {
  if (image.file.size > MAX_BYTES) return { kind: 'refused', reason: 'too_large' };
  const query = new URLSearchParams({ operation: image.operation, name: image.name });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`/api/admin/frames/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: image.file,
      });
      if (response.status === 401) return { kind: 'failed', signedOut: true };
      if (response.ok || response.status === 413) return (await response.json()) as UploadOutcome;
    } catch {
      // A dropped connection: one more try, then report it.
    }
  }
  return { kind: 'failed', signedOut: false };
}

export default function ImageUploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    // Not in React's typings, so set directly: lets the picker choose a folder.
    input.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  async function upload() {
    if (!plan) return;
    stop.current = false;
    setRunning(true);
    setResults(null);
    setSignedOut(false);
    setDone(0);
    const collected: Result[] = [];
    let next = 0;
    const worker = async () => {
      while (!stop.current && next < plan.images.length) {
        const image = plan.images[next++];
        const result = await uploadOne(image);
        collected.push(result);
        setDone(collected.length);
        if (result.kind === 'failed' && result.signedOut) {
          // The admin session ran out; nothing more will get through until they sign in again.
          stop.current = true;
          setSignedOut(true);
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setRunning(false);
    setResults(collected);
    router.refresh();
  }

  const added = results?.filter((r) => r.kind === 'added').length ?? 0;
  const sameImage = results?.filter((r) => r.kind === 'duplicate' && r.reason === 'same_image').length ?? 0;
  const sameName = results?.filter((r) => r.kind === 'duplicate' && r.reason === 'same_name').length ?? 0;
  const failed = results?.filter((r) => r.kind === 'failed').length ?? 0;
  const refusedBy = new Map<UploadRefusal, number>();
  for (const result of results ?? []) {
    if (result.kind === 'refused') refusedBy.set(result.reason, (refusedBy.get(result.reason) ?? 0) + 1);
  }
  const notSent = plan && results ? plan.images.length - results.length : 0;

  return (
    <div>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) {
            setPlan(planFrom(event.target.files));
            setResults(null);
            setDone(0);
          }
          event.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={running}
        onClick={() => input.current?.click()}
        className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100
                   disabled:bg-zinc-800 disabled:text-zinc-600"
      >
        Choose a folder…
      </button>

      {plan && (
        <div className="mt-4 rounded-lg border border-zinc-800 p-4 text-sm">
          {plan.images.length === 0 ? (
            <p className="text-amber-300">
              No PNG or JPEG images were found in {plan.folder ? `“${plan.folder}”` : 'that folder'}.
            </p>
          ) : (
            <>
              <p className="text-zinc-200">
                {plan.images.length} {plan.images.length === 1 ? 'image' : 'images'} in {plan.operations.length}{' '}
                {plan.operations.length === 1 ? 'operation' : 'operations'}
                {plan.folder ? ` from “${plan.folder}”` : ''}.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-500">Show operations</summary>
                <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs text-zinc-400 sm:grid-cols-2 lg:grid-cols-3">
                  {plan.operations.map(([operation, count]) => (
                    <li key={operation} className="flex justify-between gap-3">
                      <span className="truncate">{operation}</span>
                      <span className="tabular-nums text-zinc-500">{count}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {(plan.notImages > 0 || plan.practice > 0) && (
            <p className="mt-2 text-xs text-zinc-500">
              {plan.notImages > 0 &&
                `${count(plan.notImages, 'other file', 'other files')} will be left out (only PNG and JPEG are used). `}
              {plan.practice > 0 &&
                `${count(plan.practice, 'image', 'images')} in a “practice” folder will be left out: practice images are chosen once, at setup.`}
            </p>
          )}

          {plan.images.length > 0 && !running && !results && (
            <button
              type="button"
              onClick={upload}
              className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
            >
              Upload {plan.images.length} {plan.images.length === 1 ? 'image' : 'images'}
            </button>
          )}

          {(running || results) && (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-zinc-200 transition-[width]"
                  style={{ width: `${Math.round((done / plan.images.length) * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-xs tabular-nums text-zinc-400">
                {running ? `Uploading ${done} of ${plan.images.length}… keep this page open.` : 'Finished.'}
                {running && (
                  <button
                    type="button"
                    onClick={() => {
                      stop.current = true;
                    }}
                    className="ml-3 text-zinc-500 underline hover:text-zinc-300"
                  >
                    Stop
                  </button>
                )}
              </p>
            </div>
          )}

          {results && (
            <ul role="status" className="mt-3 space-y-1 text-sm">
              <li className="text-emerald-300">
                {count(added, 'image', 'images')} added to the spare pool.
              </li>
              {sameImage > 0 && (
                <li className="text-zinc-400">
                  {sameImage === 1 ? '1 was' : `${sameImage} were`} already in the study, so skipped.
                </li>
              )}
              {sameName > 0 && (
                <li className="text-amber-300">
                  {sameName === 1 ? '1 has' : `${sameName} have`} the same operation and file name as a different
                  image already in the study, so skipped. Rename such files if they are new images.
                </li>
              )}
              {[...refusedBy.entries()].map(([reason, count]) => (
                <li key={reason} className="text-amber-300">
                  {count} skipped: {REFUSAL_TEXT[reason]}.
                </li>
              ))}
              {failed > 0 && (
                <li className="text-amber-300">
                  {count(failed, 'image', 'images')} did not get through. Choose the folder again to retry; images
                  already added are skipped.
                </li>
              )}
              {notSent > 0 && (
                <li className="text-zinc-400">
                  {count(notSent, 'image', 'images')} not sent because the upload was stopped. Choose the folder
                  again to carry on.
                </li>
              )}
              {signedOut && (
                <li className="text-amber-300">
                  Your admin session ended. Sign in again on the study administration page, then carry on.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

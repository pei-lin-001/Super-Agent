import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInsideRoot } from '../../src/tools/paths.ts';
import test from 'node:test';
import { fileTools } from '../../src/tools/files.ts';
import { editTools } from '../../src/tools/edit.ts';
import { docTools } from '../../src/tools/docs.ts';
import { netTools } from '../../src/tools/net.ts';
import type { ToolContext, ToolDefinition } from '../../src/tools/types.ts';

const get = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const found = tools.find((item) => item.name === name);
  assert.ok(found);
  return found;
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sa-tools-'));
  const dir = join(root, 'task');
  const materials = join(root, 'materials');
  await mkdir(dir); await mkdir(materials);
  const context = { task: { id: 'task' }, workDir: root, materialsDir: materials, readRoot: root } as ToolContext;
  return { root, dir, materials, context, close: () => rm(root, { recursive: true, force: true }) };
}

test('单文件和目录搜索给出可复用完整路径，缺失路径明确报错', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'a', 'b'), { recursive: true });
    await writeFile(join(f.dir, 'a', 'b', 'x.txt'), 'one\nNeedle\n');
    await writeFile(join(f.dir, '.env.local'), 'Needle secret');
    const run = get(fileTools, 'fs_search').run;
    assert.match((await run({ pattern: 'needle', path: 'a/b/x.txt' }, f.context)).content, /a\/b\/x\.txt:2: Needle/);
    const result = await run({ pattern: 'needle' }, f.context);
    assert.match(result.content, /a\/b\/x\.txt:2/);
    assert.match(result.content, /跳过受保护凭据文件 1 个/);
    assert.doesNotMatch(result.content, /secret/);
    await assert.rejects(async () => run({ pattern: 'needle', path: 'missing' }, f.context), /无法访问搜索路径.*ENOENT/);
    await assert.rejects(async () => run({ pattern: '[' }, f.context), /正则无效/);
  } finally { await f.close(); }
});

test('内容搜索回执区分实际覆盖、观察到的跳过项和未知剩余范围', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'report.txt'), 'needle\n');
    await writeFile(join(f.dir, 'paper.pdf'), '%PDF-1.4');
    await writeFile(join(f.dir, 'archive.bin'), 'needle');
    await writeFile(join(f.dir, 'large.txt'), Buffer.alloc(2_000_001));

    const search = get(fileTools, 'fs_search');
    const result = await search.run({ pattern: 'needle' }, f.context);
    assert.match(result.content, /^搜索范围：已读取文本文件 1 个；跳过 PDF 1 个；跳过其他非文本扩展名 1 个；跳过超过 .* 的文件 1 个；已遍历起点下符合搜索规则的文件；这是文本搜索/s);
    assert.match(result.content, /report\.txt:1: needle/);
    assert.doesNotMatch(result.content, /paper\.pdf:|archive\.bin:/);

    const explicitPdf = await search.run({ pattern: 'needle', path: 'paper.pdf' }, f.context);
    assert.match(explicitPdf.content, /跳过 PDF 1 个/);
    assert.match(explicitPdf.content, /不包含被跳过的 PDF 内容/);
  } finally { await f.close(); }
});

test('内容搜索达到文件或结果上限时将未检查范围标为未知', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'many'));
    await Promise.all(Array.from({ length: 301 }, (_, index) =>
      writeFile(join(f.dir, 'many', `${String(index).padStart(3, '0')}.txt`), 'miss'),
    ));
    const search = get(fileTools, 'fs_search');
    const fileLimited = await search.run({ pattern: 'hit', path: 'many' }, f.context);
    assert.match(fileLimited.content, /达到 300 个已读取文本文件上限，剩余范围未检查且数量未知/);
    assert.match(fileLimited.content, /已读取文本文件 300 个/);

    await rm(join(f.dir, 'many'), { recursive: true, force: true });
    await mkdir(join(f.dir, 'many'));
    await writeFile(join(f.dir, 'many', 'matches.txt'), Array.from({ length: 100 }, (_, index) => `hit ${index}`).join('\n'));
    const resultLimited = await search.run({ pattern: 'hit', path: 'many' }, f.context);
    assert.match(resultLimited.content, /达到 80 条结果上限，剩余范围未检查且数量未知/);
    assert.match(resultLimited.content, /^搜索范围：/);
    assert.match(resultLimited.content, /matches\.txt:80: hit 79/);
    assert.doesNotMatch(resultLimited.content, /matches\.txt:81:/);
  } finally { await f.close(); }
});

test('所有直接写入入口拒绝产物及链接别名，空文本可写入', async () => {
  const f = await fixture();
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('body'); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await mkdir(join(f.dir, 'artifacts', 'v1'), { recursive: true });
    await writeFile(join(f.dir, 'artifacts', 'v1', 'a.txt'), 'original');
    await symlink(join(f.dir, 'artifacts'), join(f.dir, 'alias'));
    await link(join(f.dir, 'artifacts', 'v1', 'a.txt'), join(f.dir, 'hardlink.txt'));
    const target = 'artifacts/v1/a.txt';
    await assert.rejects(async () => get(editTools, 'fs_edit').run({ path: target, old_string: 'original', new_string: 'changed' }, f.context), /产物目录/);
    await assert.rejects(async () => get(fileTools, 'fs_write').run({ path: 'alias/v1/a.txt', content: 'changed' }, f.context), /只读或产物目录/);
    await assert.rejects(async () => get(fileTools, 'fs_write').run({ path: 'hardlink.txt', content: 'changed' }, f.context), /硬链接/);
    const port = (server.address() as { port: number }).port;
    await assert.rejects(async () => get(netTools, 'net_fetch').run({ url: `http://127.0.0.1:${port}/`, save_to: target }, f.context), /产物目录/);
    assert.equal(await readFile(join(f.dir, target), 'utf8'), 'original');
    await get(fileTools, 'fs_write').run({ path: 'empty.txt', content: '' }, f.context);
    assert.equal(await readFile(join(f.dir, 'empty.txt'), 'utf8'), '');
  } finally { await new Promise<void>((done) => server.close(() => done())); await f.close(); }
});

test('读取分页、图片、glob 与多次替换的真实结果一致', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'lines.txt'), 'first\n\nthird\n');
    await mkdir(join(f.dir, 'src'));
    await writeFile(join(f.dir, 'src', 'a.ts'), 'source');
    await symlink(join(f.dir, 'src'), join(f.dir, 'source-link'));
    await get(fileTools, 'fs_write').run({ path: 'source-link/b.ts', content: 'ok' }, f.context);
    const nestedGlob = await get(editTools, 'fs_glob').run({ path: 'src', pattern: '*.ts' }, f.context);
    assert.match(nestedGlob.content, /src\/a\.ts/);
    assert.match((await get(fileTools, 'fs_read').run({ path: 'src/a.ts' }, f.context)).content, /source/);
    const read = get(fileTools, 'fs_read');
    assert.match((await read.run({ path: 'lines.txt', offset: 2, limit: 1 }, f.context)).content, /offset=3/);
    assert.doesNotMatch((await read.run({ path: 'lines.txt', offset: 3 }, f.context)).content, /继续请用/);
    await writeFile(join(f.dir, 'picture.png'), Buffer.from([137, 80, 78, 71]));
    const image = await get(fileTools, 'fs_view_image').run({ path: 'picture.png' }, f.context);
    assert.equal(image.type, 'ok');
    if (image.type === 'ok') assert.equal(image.images?.[0]?.data, 'iVBORw==');
    const glob = await get(editTools, 'fs_glob').run({ pattern: '*.txt' }, f.context);
    assert.match(glob.content, /lines.txt/);
    await assert.rejects(async () => get(editTools, 'fs_edit').run({ path: 'lines.txt', edits: [{ old_string: 'first', new_string: 'other' }, { old_string: 'first', new_string: 'x' }] }, f.context), /第 2 处/);
    assert.equal(await readFile(join(f.dir, 'lines.txt'), 'utf8'), 'first\n\nthird\n');
  } finally { await f.close(); }
});

test('notebook 截断会提示，联网长正文落盘且取消覆盖响应正文', async () => {
  const f = await fixture();
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    if (req.url === '/slow') { res.write('partial'); setTimeout(() => res.end('end'), 1200); }
    else res.end('a'.repeat(9000));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await writeFile(join(f.dir, 'n.ipynb'), JSON.stringify({ cells: [{ cell_type: 'code', source: ['x'.repeat(600)] }] }));
    const notebook = await get(docTools, 'doc_notebook').run({ path: 'n.ipynb', limit: 500 }, f.context);
    assert.match(notebook.content, /超过输出上限/);
    const port = (server.address() as { port: number }).port;
    const fetch = get(netTools, 'net_fetch');
    const long = await fetch.run({ url: `http://127.0.0.1:${port}/long` }, f.context);
    assert.match(long.content, /已保存：downloads\/long.bin/);
    assert.equal((await readFile(join(f.dir, 'downloads', 'long.bin'))).length, 9000);
    const controller = new AbortController();
    const pending = fetch.run({ url: `http://127.0.0.1:${port}/slow` }, { ...f.context, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(async () => pending, /已取消/);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await f.close(); }
});

test('首次写入任务目录以及路径链接边界', async () => {
  const f = await fixture();
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('网络内容'); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await rm(f.dir, { recursive: true });
    await get(fileTools, 'fs_write').run({ path: 'first/out.txt', content: '首次文件' }, f.context);
    assert.equal(await readFile(join(f.dir, 'first/out.txt'), 'utf8'), '首次文件');
    await rm(f.dir, { recursive: true });
    const port = (server.address() as { port: number }).port;
    await get(netTools, 'net_fetch').run({ url: `http://127.0.0.1:${port}/`, save_to: 'download/out.txt' }, f.context);
    assert.equal(await readFile(join(f.dir, 'download/out.txt'), 'utf8'), '网络内容');
    for (const prefix of ['materials', 'inputs', 'artifacts']) {
      await assert.rejects(async () => get(fileTools, 'fs_write').run({ path: `${prefix}/x`, content: 'x' }, f.context), /只读|产物目录/);
    }
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.dir, 'escape'));
    await assert.rejects(async () => get(fileTools, 'fs_write').run({ path: 'escape/x', content: 'x' }, f.context), /符号链接/);
    await symlink(join(f.root, 'missing'), join(f.dir, 'dangling'));
    await assert.rejects(async () => get(fileTools, 'fs_write').run({ path: 'dangling/x', content: 'x' }, f.context), /符号链接/);
    assert.throws(() => assertInsideRoot(f.dir, join(f.root, 'task-other', 'x')), /目录之外/);
    await symlink(f.root, join(f.root, 'parent-link'));
    const linkedRoot = join(f.root, 'parent-link', 'new-task');
    assert.doesNotThrow(() => assertInsideRoot(linkedRoot, join(linkedRoot, 'new', 'x')));
    await symlink(outside, join(f.root, 'linked-task'));
    assert.doesNotThrow(() => assertInsideRoot(join(f.root, 'linked-task'), join(f.root, 'linked-task', 'new')));
    await symlink(f.root, join(outside, 'escape-back'));
    assert.throws(() => assertInsideRoot(join(f.root, 'linked-task'), join(f.root, 'linked-task', 'escape-back', 'x')), /目录之外/);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await f.close(); }
});

test('读取回执明确区分任务目录、materials、仓库根与绝对路径', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'inside.txt'), 'task needle');
    await writeFile(join(f.root, 'repo.txt'), 'root needle');
    await writeFile(join(f.materials, 'input.txt'), 'material');
    const read = get(fileTools, 'fs_read');

    assert.match((await read.run({ path: 'inside.txt' }, f.context)).content, /路径来源：任务目录（task）.*实际路径：.*task\/inside\.txt/s);
    assert.match((await read.run({ path: 'repo.txt' }, f.context)).content, /路径来源：仓库只读根.*请求路径：repo\.txt.*实际路径：.*repo\.txt/s);
    assert.match((await read.run({ path: 'materials/input.txt' }, f.context)).content, /路径来源：只读材料目录.*实际路径：.*materials\/input\.txt/s);
    assert.match((await read.run({ path: join(f.root, 'repo.txt') }, f.context)).content, /路径来源：显式绝对路径.*实际路径：.*repo\.txt/s);

    const search = await get(fileTools, 'fs_search').run({ pattern: 'needle' }, f.context);
    assert.match(search.content, /路径来源：任务目录（task）/);
    assert.match(search.content, /inside\.txt:1: task needle/);
    assert.doesNotMatch(search.content, /repo\.txt/);
    const rootSearch = await get(fileTools, 'fs_search').run({ pattern: 'needle', path: f.root }, f.context);
    assert.match(rootSearch.content, /路径来源：显式绝对路径/);
    assert.match(rootSearch.content, /repo\.txt:1: root needle/);

    const glob = await get(editTools, 'fs_glob').run({ path: f.root, pattern: '*.txt' }, f.context);
    assert.match(glob.content, /路径来源：显式绝对路径/);
    assert.match(glob.content, /repo\.txt/);
    const stat = await get(editTools, 'fs_stat').run({ path: 'repo.txt' }, f.context);
    assert.match(stat.content, /路径来源：仓库只读根/);
    assert.match(stat.content, /绝对路径：.*repo\.txt/);
  } finally { await f.close(); }
});

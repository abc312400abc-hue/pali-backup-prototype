const DB_NAME = 'pali-backup-prototype';
const DB_VERSION = 1;
const STORE = 'kv';
const HANDLE_KEY = 'backupHandle';
const DATA_KEY = 'personalData';
const $ = id => document.getElementById(id);
let db;

function log(message, type='info') {
  const time = new Date().toLocaleTimeString();
  const prefix = type === 'error' ? '✖' : type === 'ok' ? '✓' : '•';
  $('log').textContent = `[${time}] ${prefix} ${message}\n` + $('log').textContent;
}
function openDB() {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function getValue(key) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(STORE,'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function setValue(key,value) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(value,key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务中止'));
  });
}
function defaultData() {
  return { learning: [], settings: { dailyNewWordGoal: 10, theme: 'light' }, updatedAt: new Date().toISOString() };
}
async function loadData() {
  let data = await getValue(DATA_KEY);
  if (!data) { data = defaultData(); await setValue(DATA_KEY,data); }
  return data;
}
async function saveData(data) {
  data.updatedAt = new Date().toISOString();
  await setValue(DATA_KEY,data);
  await refresh();
}
async function refresh() {
  const data = await loadData();
  $('recordCount').textContent = data.learning.length;
  $('settingValue').textContent = data.settings.dailyNewWordGoal;
  $('dataPreview').textContent = JSON.stringify(data,null,2);
  const handle = await getValue(HANDLE_KEY);
  $('handleStatus').textContent = handle ? '已保存（需检查权限）' : '未选择';
}
async function requestHandlePermission(handle, mode='readwrite') {
  if (!handle) return false;
  let permission = await handle.queryPermission({mode});
  if (permission !== 'granted') permission = await handle.requestPermission({mode});
  return permission === 'granted';
}
function bytesToHex(buffer) { return [...new Uint8Array(buffer)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function sha256(text) {
  if (!crypto.subtle) throw new Error('当前环境不支持安全校验（需要 HTTPS 或 localhost）');
  return bytesToHex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
}
async function makeBackup() {
  const data = await loadData();
  const payload = { learning: data.learning, settings: data.settings, updatedAt: data.updatedAt };
  const payloadText = JSON.stringify(payload);
  return {
    format: 'palbackup',
    backupVersion: 1,
    app: 'pali-backup-prototype',
    createdAt: new Date().toISOString(),
    payload,
    checksum: await sha256(payloadText)
  };
}
async function validateBackup(backup) {
  if (!backup || backup.format !== 'palbackup' || backup.backupVersion !== 1 || !backup.payload) throw new Error('文件格式或版本不受支持');
  if (!Array.isArray(backup.payload.learning) || !backup.payload.settings) throw new Error('备份内容结构不完整');
  const actual = await sha256(JSON.stringify(backup.payload));
  if (actual !== backup.checksum) throw new Error('校验和不匹配，文件可能损坏或被修改');
  return true;
}
async function writeHandle(handle) {
  const backup = await makeBackup();
  const text = JSON.stringify(backup,null,2);
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  const file = await handle.getFile();
  const readBack = JSON.parse(await file.text());
  await validateBackup(readBack);
  $('backupStatus').textContent = new Date().toLocaleString();
  log(`已写入并重新读取校验：${file.name}（${file.size} bytes）`,'ok');
  return readBack;
}
async function restoreBackup(backup) {
  await validateBackup(backup);
  const current = await loadData();
  // Keep a rollback snapshot in the same IndexedDB transaction boundary before replacing data.
  await setValue('preRestoreSafetyCopy',current);
  const restored = {
    learning: backup.payload.learning,
    settings: backup.payload.settings,
    updatedAt: backup.payload.updatedAt || new Date().toISOString()
  };
  await setValue(DATA_KEY,restored);
  await refresh();
  log(`恢复成功：${restored.learning.length} 条学习记录。教学内容 Content 不在此备份内。`,'ok');
}
async function readSelectedFile(file) {
  const backup = JSON.parse(await file.text());
  await validateBackup(backup);
  log(`文件校验成功：${file.name}，创建于 ${backup.createdAt}`,'ok');
  return backup;
}

$('addRecord').addEventListener('click',async()=>{
  try {
    const data=await loadData();
    const n=data.learning.length+1;
    data.learning.push({id:`test_${Date.now()}`,lemma:['gaṇhāti','dadāti','gacchati','jānāti','passati'][data.learning.length%5],state:'LEARNING',reviewStage:0,nextReviewAt:new Date(Date.now()+86400000).toISOString(),createdAt:new Date().toISOString(),testSequence:n});
    await saveData(data); log(`新增模拟记录，当前共 ${data.learning.length} 条。`,'ok');
  } catch(e){log(e.message,'error');}
});
$('changeSetting').addEventListener('click',async()=>{
  try {const data=await loadData();data.settings.dailyNewWordGoal=data.settings.dailyNewWordGoal===10?15:10;await saveData(data);log(`每日新词目标已改为 ${data.settings.dailyNewWordGoal}。`,'ok');}catch(e){log(e.message,'error');}
});
$('showData').addEventListener('click',refresh);
$('clearLocal').addEventListener('click',async()=>{
  if(!confirm('这会删除本原型的本地学习数据和已保存的文件句柄，但不会主动删除手机中的外部备份文件。确定继续？')) return;
  db.close();
  await new Promise((resolve,reject)=>{const req=indexedDB.deleteDatabase(DB_NAME);req.onsuccess=resolve;req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('数据库仍被其他页面占用，请关闭其他原型页面后重试'));});
  db=await openDB(); await refresh(); $('backupStatus').textContent='本地数据已清除';
  log('本地 IndexedDB 已清除。外部备份文件应仍在原位置；请用文件选择器重新选择并恢复。','ok');
});
$('chooseBackup').addEventListener('click',async()=>{
  try {
    if(!('showSaveFilePicker' in window)) throw new Error('当前浏览器没有 showSaveFilePicker；请使用“下载 JSON 备份”备用方案。');
    const handle=await window.showSaveFilePicker({suggestedName:'Pali_Learning_Test.palbackup',types:[{description:'Pāli backup',accept:{'application/json':['.palbackup','.json']}}]});
    const granted=await requestHandlePermission(handle,'readwrite');
    if(!granted) throw new Error('未获得文件读写权限。');
    await setValue(HANDLE_KEY,handle); await refresh();
    log(`已选择文件：${handle.name}。现在可以写入快照。`,'ok');
  } catch(e){ if(e.name!=='AbortError') log(e.message,'error'); }
});
$('writeBackup').addEventListener('click',async()=>{
  try {
    let handle=await getValue(HANDLE_KEY);
    if(!handle){log('尚未选择备份文件，请先选择或创建文件。','error');return;}
    const granted=await requestHandlePermission(handle,'readwrite');
    if(!granted){log('文件权限未获批准，请重新选择文件。','error');return;}
    await writeHandle(handle);
  }catch(e){log(`写入失败：${e.message}`,'error');}
});
$('readBackup').addEventListener('click',async()=>{
  try {
    const handle=await getValue(HANDLE_KEY); if(!handle) throw new Error('没有已保存的文件句柄。');
    if(!await requestHandlePermission(handle,'read')) throw new Error('没有读取权限，请重新选择文件。');
    const file=await handle.getFile(); await readSelectedFile(file);
  }catch(e){log(`读取失败：${e.message}`,'error');}
});
$('importBackup').addEventListener('click',async()=>{
  try {
    const handle=await getValue(HANDLE_KEY); if(!handle) throw new Error('没有已保存的文件句柄。');
    if(!await requestHandlePermission(handle,'read')) throw new Error('没有读取权限，请重新选择文件。');
    const file=await handle.getFile(); const backup=await readSelectedFile(file);
    if(confirm(`确认从 ${file.name} 恢复 ${backup.payload.learning.length} 条学习记录？当前数据将先保存安全副本。`)) await restoreBackup(backup);
  }catch(e){log(`恢复失败：${e.message}`,'error');}
});
$('downloadBackup').addEventListener('click',async()=>{
  try {
    const backup=await makeBackup(); const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='Pali_Learning_Backup.palbackup'; a.click(); URL.revokeObjectURL(url);
    log('已生成下载备份。请确认浏览器确实将文件保存到手机。','ok');
  }catch(e){log(`导出失败：${e.message}`,'error');}
});
$('fileInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0]; if(!file)return;
  try {const backup=await readSelectedFile(file);if(confirm(`确认从 ${file.name} 恢复 ${backup.payload.learning.length} 条学习记录？`)) await restoreBackup(backup);}
  catch(err){log(`文件恢复失败：${err.message}`,'error');}
  finally{e.target.value='';}
});
$('clearLog').addEventListener('click',()=>$('log').textContent='日志已清空。');

(async()=>{
  try {
    db=await openDB(); await refresh();
    const supported='showSaveFilePicker' in window && 'showOpenFilePicker' in window;
    $('apiStatus').textContent=supported?'检测到文件访问 API':'未检测到完整文件访问 API';
    $('connection').textContent=`${location.protocol==='https:'?'HTTPS 安全环境':location.hostname==='localhost'?'本地测试环境':'非安全环境'} · ${navigator.onLine?'当前联网':'当前离线'}`;
    if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')) navigator.serviceWorker.register('./sw.js').catch(e=>log(`Service Worker 注册失败：${e.message}`,'error'));
    log('数据库已就绪。学习数据仅保存在本设备浏览器中。','ok');
    if(!supported) log('当前浏览器未提供完整文件访问 API；可使用下载/手动选择文件测试备用路径。');
  }catch(e){log(`初始化失败：${e.message}`,'error');}
})();

import type { ModelSetupStatus } from '../shared/model-downloads';

export function ModelProgress({ status }: { status: ModelSetupStatus }) {
  const failed = status.state === 'error';
  const awaitingSetup = status.state === 'setup';
  const transferring = status.state === 'downloading' && !status.activity;
  const label = failed ? '准备失败，请检查网络和磁盘空间。'
    : awaitingSetup ? status.message
    : status.activity === 'importing' ? '正在导入已有模型'
    : status.activity === 'verifying' ? '正在校验下载'
    : status.activity === 'extracting' ? '正在安装字幕模型'
    : transferring ? '正在下载'
    : '正在检查本地模型';
  const currentFraction = status.totalBytes ? Math.min(1, status.downloadedBytes / status.totalBytes) : 0;
  const progress = status.completedFiles + currentFraction;
  const megabytes = (bytes: number) => Math.round(bytes / 1_000_000).toLocaleString();
  return <div className="model-progress">
    <p role={failed ? 'alert' : 'status'}>{label}</p>
    {failed ? <details className="model-error"><summary>查看错误详情</summary><p>{status.message}</p></details> : awaitingSetup ? (
      <small>{status.totalFiles ? `待准备 ${status.totalFiles - status.completedFiles} / ${status.totalFiles} 个文件` : '基础模型约 4.8 GB，支持断点续传'}</small>
    ) : <>
      <progress aria-label="准备进度" value={status.totalFiles ? progress : undefined} max={status.totalFiles || 1}/>
      <small>{!!status.totalFiles && `已准备 ${status.completedFiles} / ${status.totalFiles} 个文件`}
        {transferring && status.downloadedBytes > 0 && ` · 当前文件 ${megabytes(status.downloadedBytes)}${status.totalBytes ? ` / ${megabytes(status.totalBytes)}` : ''} MB`}</small>
    </>}
  </div>;
}

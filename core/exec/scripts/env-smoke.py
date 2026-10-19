"""执行环境自检：证明"这台机器 + 这个 venv"真的能算、能出指标、能落产物。

用途有两个：
  1. 用户/调试时点一下，确认执行链路（venv → 进程 → 产物 → manifest）是通的；
  2. 自动化测试用它验收执行器本身，不需要联网、不需要大数据集、不需要 GPU。

契约与其它模板相同：参数走 CLI、产物写 ./artifacts/、必须产出 metrics.json。
"""

import argparse
import json
import os
import platform
import sys
import time

ART = "artifacts"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dim", type=int, default=256)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--sleep-sec", type=float, default=0.0)
    args = parser.parse_args()

    if not 16 <= args.dim <= 2048:
        print("ERROR: dim 越界", flush=True)
        sys.exit(2)
    if not 0.0 <= args.sleep_sec <= 600.0:
        print("ERROR: sleep-sec 越界", flush=True)
        sys.exit(2)

    try:
        import numpy as np
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: numpy 不可用：{exc}", flush=True)
        sys.exit(2)

    if args.sleep_sec:
        print(f"按参数等待 {args.sleep_sec}s（用于验证超时与取消）", flush=True)
        time.sleep(args.sleep_sec)

    started = time.perf_counter()
    rng = np.random.default_rng(args.seed)
    a = rng.normal(size=(args.dim, args.dim))
    b = rng.normal(size=(args.dim, args.dim))
    product = a @ b
    trace = float(np.trace(product))
    checksum = float(np.abs(product).sum() % 100000.0)
    seconds = time.perf_counter() - started
    print(f"矩阵乘 {args.dim}×{args.dim} 完成：{seconds:.4f}s, trace={trace:.4f}", flush=True)

    os.makedirs(ART, exist_ok=True)
    with open(os.path.join(ART, "metrics.json"), "w", encoding="utf-8") as handle:
        # 只写本次真实算出来的量；dim/seed 这类参数由执行器的 manifest.params 承载，
        # 不放进指标表，免得参数冒充实验结果。
        json.dump(
            {
                "env": {
                    "numpy": np.__version__,
                    "python": platform.python_version(),
                    "platform": platform.platform(),
                },
                "run": {
                    "seconds": round(seconds, 6),
                    "matrix_trace": round(trace, 6),
                    "checksum": round(checksum, 6),
                },
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    with open(os.path.join(ART, "summary.txt"), "w", encoding="utf-8") as handle:
        handle.write(f"dim={args.dim} seed={args.seed} trace={trace:.6f} checksum={checksum:.6f}\n")
    print("METRICS run.seconds=%.6f run.matrix_trace=%.6f" % (seconds, trace), flush=True)


if __name__ == "__main__":
    main()

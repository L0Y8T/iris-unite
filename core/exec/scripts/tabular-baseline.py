"""表格分类基线：Iris Unite 受控实验模板 v1。

契约（执行器与模板之间的约定，改动必须同时改 templates.cjs）：
  1. 只接收白名单 CLI 参数，参数已由执行器校验，这里再断言一次边界。
  2. 当前工作目录就是 run 目录；所有产物写进 ./artifacts/。
  3. 必须写 ./artifacts/metrics.json，形如
       {"test": {"accuracy": 0.97, "macro_f1": 0.96, "n_samples": 1797},
        "train": {"seconds": 0.42}, "params": {...}}
     数字必须是**本次运行真实算出来的**，不允许回填常数。
  4. 失败时打印一行 ERROR: 原因 并以非零码退出。
  5. 不联网、不读 run 目录以外的文件、不写 run 目录以外的文件。
"""

import argparse
import json
import os
import sys
import time

ART = "artifacts"


def fail(message: str, code: int = 2) -> None:
    print(f"ERROR: {message}", flush=True)
    sys.exit(code)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="digits")
    parser.add_argument("--model", default="logreg")
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not 0.1 <= args.test_size <= 0.5:
        fail("test-size 越界")
    if not 0 <= args.seed <= 2**32 - 1:
        fail("seed 越界")

    try:
        import numpy as np
    except Exception as exc:  # noqa: BLE001
        fail(f"numpy 不可用：{exc}")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from sklearn.datasets import load_breast_cancer, load_digits, load_iris, load_wine
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
        from sklearn.model_selection import train_test_split
        from sklearn.neural_network import MLPClassifier
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
    except Exception as exc:  # noqa: BLE001
        fail(f"依赖不可用：{exc}")

    loaders = {"digits": load_digits, "wine": load_wine, "breast_cancer": load_breast_cancer, "iris": load_iris}
    if args.dataset not in loaders:
        fail(f"未知数据集 {args.dataset}")

    data = loaders[args.dataset]()
    X, y = data.data, data.target
    print(f"数据集 {args.dataset}: {X.shape[0]} 样本 × {X.shape[1]} 特征, {len(set(y.tolist()))} 类", flush=True)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_size, random_state=args.seed, stratify=y
    )

    builders = {
        "logreg": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, random_state=args.seed)),
        "random_forest": lambda: RandomForestClassifier(n_estimators=200, random_state=args.seed),
        "mlp": lambda: make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(64,), max_iter=600, random_state=args.seed)),
    }
    if args.model not in builders:
        fail(f"未知模型 {args.model}")

    model = builders[args.model]()
    started = time.perf_counter()
    model.fit(X_train, y_train)
    train_seconds = time.perf_counter() - started
    print(f"训练完成：{train_seconds:.3f}s", flush=True)

    pred = model.predict(X_test)
    accuracy = float(accuracy_score(y_test, pred))
    macro_f1 = float(f1_score(y_test, pred, average="macro"))
    print(f"测试集准确率 {accuracy:.4f}, macro-F1 {macro_f1:.4f}", flush=True)

    os.makedirs(ART, exist_ok=True)

    cm = confusion_matrix(y_test, pred)
    fig, ax = plt.subplots(figsize=(4.2, 3.6), dpi=160)
    ax.imshow(cm, cmap="Blues")
    ax.set_title(f"{args.dataset} / {args.model}")
    ax.set_xlabel("predicted")
    ax.set_ylabel("true")
    for (row, col), value in np.ndenumerate(cm):
        ax.text(col, row, str(int(value)), ha="center", va="center", fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(ART, "confusion-matrix.png"))
    plt.close(fig)

    payload = {
        "test": {"accuracy": accuracy, "macro_f1": macro_f1, "n_samples": int(len(y_test))},
        "train": {"seconds": round(train_seconds, 4), "n_samples": int(len(y_train))},
        "params": {"dataset": args.dataset, "model": args.model, "testSize": args.test_size, "seed": args.seed},
    }
    with open(os.path.join(ART, "metrics.json"), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print("METRICS test.accuracy=%.4f test.macro_f1=%.4f" % (accuracy, macro_f1), flush=True)


if __name__ == "__main__":
    main()

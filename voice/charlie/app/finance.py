"""金融行情 — Sina Finance API（免费无Key，中国直连）

A股个股/指数/外汇实时行情
"""
import re, logging, requests

log = logging.getLogger("magic")

# 指数代码
_INDEX_CODES = {
    "上证": "s_sh000001", "上证指数": "s_sh000001",
    "深证": "s_sz399001", "深证成指": "s_sz399001",
    "创业板": "s_sz399006", "创业板指": "s_sz399006",
    "科创50": "s_sh000688",
}

# 热门个股代码
_HOT_STOCKS = {
    "茅台": "sh600519", "贵州茅台": "sh600519",
    "平安": "sz000001", "平安银行": "sz000001",
    "比亚迪": "sz002594", "宁德时代": "sz300750",
    "阿里巴巴": "s_BABA", "腾讯": "s_00700",
}


def _parse_sina_quote(text: str) -> list[dict]:
    """解析 Sina 行情返回"""
    results = []
    for line in text.strip().split("\n"):
        m = re.match(r'var hq_str_(\w+)="([^"]*)"', line)
        if not m:
            continue
        code = m.group(1)
        data = m.group(2)
        if not data:
            continue
        parts = data.split(",")
        if code.startswith("s_"):
            # 简要指数格式: 名称,当前,涨跌,涨跌幅,成交量,成交额
            if len(parts) >= 6:
                results.append({
                    "code": code, "name": parts[0],
                    "price": float(parts[1]),
                    "change": float(parts[2]),
                    "change_pct": float(parts[3]),
                })
        elif len(parts) >= 6:
            # 完整个股格式: 名称,昨收,今开,当前,最高,最低,...
            try:
                name = parts[0]
                prev_close = float(parts[2])
                current = float(parts[3])
                high = float(parts[4])
                low = float(parts[5])
                change = current - prev_close
                change_pct = (change / prev_close * 100) if prev_close else 0
                results.append({
                    "code": code, "name": name,
                    "price": current, "prev_close": prev_close,
                    "high": high, "low": low,
                    "change": round(change, 2),
                    "change_pct": round(change_pct, 2),
                })
            except (ValueError, IndexError):
                pass
    return results


def get_stock(symbol: str = "上证") -> dict | None:
    """查询单只股票/指数行情"""
    code = _INDEX_CODES.get(symbol) or _HOT_STOCKS.get(symbol) or symbol
    try:
        r = requests.get(
            f"https://hq.sinajs.cn/list={code}",
            headers={"Referer": "https://finance.sina.com.cn"},
            timeout=5,
        )
        r.encoding = "gbk"
        results = _parse_sina_quote(r.text)
        return results[0] if results else None
    except Exception as e:
        log.debug(f"[finance] 股票查询失败: {e}")
    return None


def get_stock_text(symbol: str = "上证") -> str:
    """格式化股票行情输出"""
    q = get_stock(symbol)
    if not q:
        return f"未找到股票: {symbol}"
    change_str = f"{'↑' if q['change'] >= 0 else '↓'}{abs(q['change'])} ({q['change_pct']:.2f}%)"
    result = f"{q['name']}：{q['price']:.2f} {change_str}"
    if "high" in q:
        result += f"，最高{q['high']:.2f} 最低{q['low']:.2f}"
    return result


def get_stock_batch(symbols: list[str]) -> str:
    """批量查询多只股票"""
    codes = []
    for s in symbols:
        code = _INDEX_CODES.get(s) or _HOT_STOCKS.get(s) or s
        codes.append(code)
    try:
        r = requests.get(
            f"https://hq.sinajs.cn/list={','.join(codes)}",
            headers={"Referer": "https://finance.sina.com.cn"},
            timeout=5,
        )
        r.encoding = "gbk"
        results = _parse_sina_quote(r.text)
        if not results:
            return "查询失败"
        lines = []
        for q in results:
            change_str = f"{'↑' if q['change'] >= 0 else '↓'}{abs(q['change'])} ({q['change_pct']:.2f}%)"
            lines.append(f"  {q['name']}：{q['price']:.2f} {change_str}")
        return "\n".join(lines)
    except Exception as e:
        log.debug(f"[finance] 批量查询失败: {e}")
    return "查询失败"


def get_forex(pair: str = "USDCNY") -> dict | None:
    """查询外汇汇率"""
    try:
        r = requests.get(
            f"https://hq.sinajs.cn/list={pair}",
            headers={"Referer": "https://finance.sina.com.cn"},
            timeout=5,
        )
        r.encoding = "gbk"
        data = r.text.split('"')[1] if '"' in r.text else ""
        parts = data.split(",")
        if len(parts) >= 5:
            return {
                "pair": pair,
                "bid": float(parts[1]),
                "ask": float(parts[2]),
                "high": float(parts[4]),
                "low": float(parts[5]),
            }
    except Exception as e:
        log.debug(f"[finance] 外汇查询失败: {e}")
    return None

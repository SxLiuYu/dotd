"""体育赛事 — TheSportsDB 免费API（无需Key）

https://www.thesportsdb.com/api/v1/json/3/
"""
import logging, requests

log = logging.getLogger("magic")

# 常见联赛ID
_LEAGUES = {
    "英超": "4328", "EPL": "4328", "西甲": "4335", "La Liga": "4335",
    "德甲": "4331", "Bundesliga": "4331", "意甲": "4332", "Serie A": "4332",
    "法甲": "4334", "Ligue 1": "4334", "中超": "4376", "CSL": "4376",
    "NBA": "4387", "CBA": "4527",
    "欧冠": "4480", "UCL": "4480", "欧联": "4481",
    "NFL": "4391", "MLB": "4424", "NHL": "4380",
}

_LEAGUE_NAMES = {
    "4328": "英超", "4335": "西甲", "4331": "德甲", "4332": "意甲",
    "4334": "法甲", "4376": "中超", "4387": "NBA", "4527": "CBA",
    "4480": "欧冠", "4481": "欧联", "4391": "NFL", "4424": "MLB", "4380": "NHL",
}


def get_events_today(league: str = "英超") -> list[dict]:
    """获取指定联赛今日赛事"""
    import datetime
    today = datetime.date.today().strftime("%Y-%m-%d")
    league_id = _LEAGUES.get(league, league)
    try:
        r = requests.get(
            f"https://www.thesportsdb.com/api/v1/json/3/eventsday.php",
            params={"d": today, "l": league_id},
            timeout=10,
        )
        events = r.json().get("events") or []
        result = []
        for e in events:
            result.append({
                "sport": e.get("strSport", ""),
                "league": _LEAGUE_NAMES.get(league_id, league),
                "event": e.get("strEvent", ""),
                "home": e.get("strHomeTeam", ""),
                "away": e.get("strAwayTeam", ""),
                "time": e.get("strTime", ""),
                "status": e.get("strStatus", ""),
                "home_score": e.get("intHomeScore"),
                "away_score": e.get("intAwayScore"),
                "venue": e.get("strVenue", ""),
            })
        return result
    except Exception as e:
        log.debug(f"[sports] 赛事查询失败: {e}")
    return []


def get_events_text(league: str = "英超") -> str:
    """格式化赛事输出"""
    events = get_events_today(league)
    if not events:
        return f"今天{league}没有赛事"
    lines = [f"今天{league}赛事（{len(events)}场）："]
    for e in events:
        score = ""
        if e.get("home_score") is not None:
            score = f" {e['home_score']}-{e['away_score']}"
        time = e.get("time", "")[:5] if e.get("time") else ""
        lines.append(f"  {e['home']} vs {e['away']}{score} {time} {e.get('status','')}")
    return "\n".join(lines)


def get_all_sports_today() -> str:
    """获取今日所有体育赛事"""
    import datetime
    today = datetime.date.today().strftime("%Y-%m-%d")
    try:
        r = requests.get(
            f"https://www.thesportsdb.com/api/v1/json/3/eventsday.php",
            params={"d": today},
            timeout=10,
        )
        events = r.json().get("events") or []
        if not events:
            return "今天没有重大体育赛事"
        lines = [f"今日体育赛事（{len(events)}场）："]
        for e in events[:10]:
            sport = e.get("strSport", "")
            event = e.get("strEvent", "")
            time = e.get("strTime", "")[:5] if e.get("strTime") else ""
            lines.append(f"  [{sport}] {event} {time}")
        return "\n".join(lines)
    except Exception as e:
        log.debug(f"[sports] 查询失败: {e}")
    return "赛事查询失败"

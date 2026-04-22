from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

RULES_PATH = Path(__file__).resolve().parent / "data" / "district_rules.json"


@lru_cache(maxsize=1)
def load_district_rules() -> dict[str, Any]:
    if not RULES_PATH.exists():
        return {"city_defaults": {"default": "unknown"}, "component_rules": []}

    with RULES_PATH.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    if not isinstance(payload, dict):
        return {"city_defaults": {"default": "unknown"}, "component_rules": []}

    city_defaults = payload.get("city_defaults", {})
    component_rules = payload.get("component_rules", [])

    return {
        "city_defaults": city_defaults if isinstance(city_defaults, dict) else {"default": "unknown"},
        "component_rules": component_rules if isinstance(component_rules, list) else [],
    }


def map_district_from_components(address_components: list[dict[str, Any]]) -> str:
    rules = load_district_rules()

    for rule in rules.get("component_rules", []):
        rule_type = str(rule.get("type", "")).strip()
        rule_name = str(rule.get("name", "")).strip().lower()
        rule_district = str(rule.get("district", "unknown")).strip()
        if not rule_type or not rule_name:
            continue

        for component in address_components:
            component_types = component.get("types", [])
            if rule_type not in component_types:
                continue
            component_name = str(component.get("long_name", "")).strip().lower()
            if component_name == rule_name:
                return rule_district

    city_defaults = rules.get("city_defaults", {})
    for component in address_components:
        if "locality" in component.get("types", []):
            city_name = str(component.get("long_name", "")).strip()
            if city_name and city_name in city_defaults:
                return str(city_defaults[city_name])

    return str(city_defaults.get("default", "unknown"))

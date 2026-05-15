brightness_table = {
    (0, 30): (10, 30, 2700, 3700),
    (30, 60): (30, 50, 3700, 4700),
    (60, 90): (50, 70, 4700, 5700),
    (90, 120): (70, 90, 5700, 6200),
    (120, 150): (90, 100, 6200, 6500),
    (150, float('inf')): (100, 100, 6500, 6500)
}

def set_light(entity_id, luminosity, brightness_burst=None):
    for (min_lux, max_lux), (min_brightness, max_brightness, min_color_temp, max_color_temp) in brightness_table.items():
        if min_lux <= luminosity <= max_lux:
            brightness = round((luminosity - min_lux) / (max_lux - min_lux) * (max_brightness - min_brightness) + min_brightness)
            color_temp = round((luminosity - min_lux) / (max_lux - min_lux) * (max_color_temp - min_color_temp) + min_color_temp)

            if brightness_burst is None:
                brightness_burst = 1.0

            brightness = min(brightness * brightness_burst, 100)
            service_data = {
                "entity_id": entity_id,
                "brightness_pct": brightness,
                "color_temp": color_temp
            }
            hass.services.call("light", "turn_on", service_data, False)
            break

luminosity = data.get('luminosity')
entity_id = data.get('entity_id')
brightness_burst = data.get('brightness_burst')

set_light(entity_id, luminosity, brightness_burst)

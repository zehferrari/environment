brightness_table = {
    (0, 30): (10, 30, 1900, 2700),
    (30, 60): (30, 50, 2700, 3500),
    (60, 90): (50, 70, 3500, 4300),
    (90, 120): (70, 90, 4300, 5100),
    (120, 150): (90, 100, 5100, 5900),
    (150, float('inf')): (100, 100, 5900, 5900)
}

def color_temp_to_rgb(color_temp):
    """Convert color temperature (in Kelvin) to RGB color."""
    color_temp = max(1900, min(40000, color_temp))
    tmp_internal = color_temp / 100.0
    
    if color_temp <= 5500:
        red = 255
    else:
        red = 329.698727446 * ((tmp_internal - 55) ** -0.1332047592)
    
    if color_temp <= 5500:
        green = 99.4708025861 * math.log(tmp_internal) - 161.1195681661
    else:
        green = 288.1221695283 * ((tmp_internal - 55) ** -0.0755148492)
    
    if color_temp >= 5500:
        blue = 255
    elif color_temp <= 1900:
        blue = 0
    else:
        blue = 138.5177312231 * math.log(tmp_internal - 10) - 305.0447927307
    
    return [max(0, min(255, int(red))), max(0, min(255, int(green))), max(0, min(255, int(blue)))]

def set_light(entity_id, luminosity, brightness_burst=None):
    for (min_lux, max_lux), (min_brightness, max_brightness, min_color_temp, max_color_temp) in brightness_table.items():
        if min_lux <= luminosity <= max_lux:
            brightness = round((luminosity - min_lux) / (max_lux - min_lux) * (max_brightness - min_brightness) + min_brightness)
            color_temp = round((luminosity - min_lux) / (max_lux - min_lux) * (max_color_temp - min_color_temp) + min_color_temp)
            
            if brightness_burst is None:
                brightness_burst = 1.0
            brightness = min(brightness * brightness_burst * 10, 100)
            
            rgb_color = color_temp_to_rgb(color_temp)
            
            service_data = {
                "entity_id": entity_id,
                "brightness_pct": brightness,
                "rgb_color": rgb_color
            }
            hass.services.call("light", "turn_on", service_data, False)
            break

luminosity = data.get('luminosity')
entity_id = data.get('entity_id')
brightness_burst = data.get('brightness_burst')
set_light(entity_id, luminosity, brightness_burst)
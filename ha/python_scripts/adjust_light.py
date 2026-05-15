brightness_tables = {
    "rgb": {
        (0, 30): (10, 30, 1900, 2700),
        (30, 60): (30, 50, 2700, 3500),
        (60, 90): (50, 70, 3500, 4300),
        (90, 120): (70, 90, 4300, 5100),
        (120, 150): (90, 100, 5100, 5900),
        (150, float('inf')): (100, 100, 5900, 5900)
    },
    "temp": {
        (0, 30): (10, 30, 2700, 3700),
        (30, 60): (30, 50, 3700, 4700),
        (60, 90): (50, 70, 4700, 5700),
        (90, 120): (70, 90, 5700, 6200),
        (120, 150): (90, 100, 6200, 6500),
        (150, float('inf')): (100, 100, 6500, 6500)
    }
}

def color_temp_to_rgb(color_temp):
    """Convert color temperature (in Kelvin) to RGB color."""
    color_temp = max(1900, min(6500, color_temp))
    
    if color_temp <= 4500:
        red = 255
        green = max(0, min(255, 99.4708025861 * ((color_temp - 2000) / 100) - 161.1195681661))
        blue = max(0, min(255, 138.5177312231 * ((color_temp - 2000) / 100) - 305.0447927307))
    else:
        red = max(0, min(255, 329.698727446 * ((color_temp - 4500) / 100) ** -0.1332047592))
        green = max(0, min(255, 288.1221695283 * ((color_temp - 4500) / 100) ** -0.0755148492))
        blue = 255
    
    return [int(red), int(green), int(blue)]

def set_light(entity_id, luminosity, brightness_burst=None):
    if 'attributes' in hass.states.get(entity_id) and 'supported_color_modes' in hass.states.get(entity_id).attributes and 'rgb' in hass.states.get(entity_id).attributes['supported_color_modes']:
        light_type = "rgb"
    else:
        light_type = "temp"

    brightness_table = brightness_tables[light_type]
    
    for (min_lux, max_lux), (min_brightness, max_brightness, min_color_temp, max_color_temp) in brightness_table.items():
        if min_lux <= luminosity <= max_lux:
            brightness = round((luminosity - min_lux) / (max_lux - min_lux) * (max_brightness - min_brightness) + min_brightness)
            color_temp = round((luminosity - min_lux) / (max_lux - min_lux) * (max_color_temp - min_color_temp) + min_color_temp)
            
            brightness_burst = brightness_burst or 1.0
            brightness = min(brightness * brightness_burst * (10 if light_type == "rgb" else 1), 100)
            
            service_data = {
                "entity_id": entity_id,
                "brightness_pct": brightness
            }
            
            if light_type == "rgb":
                service_data["rgb_color"] = color_temp_to_rgb(color_temp)
            else:
                service_data["color_temp"] = color_temp
            
            hass.services.call("light", "turn_on", service_data)
            break

luminosity = data.get('luminosity')
brightness_burst = data.get('brightness_burst')

# Handle both single entity_id and list of entity_ids
entity_ids = data.get('entity_id')

# Debugging information you want to save
debugging_info = [
    f"entity_ids: {entity_ids}",
    f"type(entity_ids): {type(entity_ids)}",
    f"data: {data}"
]

if isinstance(entity_ids, list):  # Check if entity_ids is a list
    for entity_id in entity_ids:
        set_light(entity_id, luminosity, brightness_burst)
else:  # It's a single entity_id
    set_light(entity_ids, luminosity, brightness_burst)

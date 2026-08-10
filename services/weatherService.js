/**
 * Weather Service Module
 * 
 * Provides weather data and forecasts using Open-Meteo API
 * Free, open-source weather API with no authentication required
 * 
 * @module services/weatherService
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const OPEN_METEO_BASE_URL = 'https://api.open-meteo.com/v1';
const GEOCODING_BASE_URL = 'https://geocoding-api.open-meteo.com/v1';

class WeatherService {
  constructor() {
    this.baseUrl = OPEN_METEO_BASE_URL;
    this.geocodingUrl = GEOCODING_BASE_URL;
  }

  /**
   * Get tools definition for MCP registration
   */
  getTools() {
    return [
      {
        name: 'get_current_weather',
        description: 'Get current weather conditions for a location. Provide either coordinates (lat/lon) or city name.',
        inputSchema: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              description: 'Latitude coordinate (-90 to 90). Required if city not provided.'
            },
            longitude: {
              type: 'number',
              description: 'Longitude coordinate (-180 to 180). Required if city not provided.'
            },
            city: {
              type: 'string',
              description: 'City name (default: Little Rock) (e.g., "London", "New York"). Will geocode automatically if coordinates not provided.'
            },
            temperature_unit: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature unit (default: celsius)',
              default: 'celsius'
            }
          },
          oneOf: [
            { required: ['latitude', 'longitude'] },
            { required: ['city'] }
          ]
        }
      },
      {
        name: 'get_weather_forecast',
        description: 'Get detailed weather forecast for up to 16 days. Provide either coordinates or city name.',
        inputSchema: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              description: 'Latitude coordinate (-90 to 90). Required if city not provided.'
            },
            longitude: {
              type: 'number',
              description: 'Longitude coordinate (-180 to 180). Required if city not provided.'
            },
            city: {
              type: 'string',
              description: 'City name (e.g., "London", "New York"). Will geocode automatically.'
            },
            days: {
              type: 'integer',
              description: 'Number of forecast days (1-16, default: 7)',
              minimum: 1,
              maximum: 16,
              default: 7
            },
            temperature_unit: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature unit (default: celsius)',
              default: 'celsius'
            },
            include_hourly: {
              type: 'boolean',
              description: 'Include hourly forecast data (default: false)',
              default: false
            }
          },
          oneOf: [
            { required: ['latitude', 'longitude'] },
            { required: ['city'] }
          ]
        }
      },
      {
        name: 'search_location',
        description: 'Search for a location and get its coordinates. Useful for finding coordinates before requesting weather.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Location search query (city name, address, etc.)'
            },
            count: {
              type: 'integer',
              description: 'Maximum number of results to return (default: 5)',
              minimum: 1,
              maximum: 100,
              default: 5
            }
          },
          required: ['query']
        }
      }
    ];
  }

  /**
   * Geocode a location name to coordinates
   */
  async geocodeLocation(locationName) {
    try {
      const response = await axios.get(`${this.geocodingUrl}/search`, {
        params: {
          name: locationName,
          count: 1,
          language: 'en',
          format: 'json'
        },
        timeout: 10000
      });

      if (!response.data?.results || response.data.results.length === 0) {
        throw new Error(`Location "${locationName}" not found`);
      }

      const location = response.data.results[0];
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        name: location.name,
        country: location.country,
        admin1: location.admin1,
        timezone: location.timezone
      };
    } catch (error) {
      logger.error('Geocoding failed', { location: locationName, error: error.message });
      throw new Error(`Failed to find location "${locationName}": ${error.message}`);
    }
  }

  /**
   * Search for locations
   */
  async searchLocation(query, count = 5) {
    try {
      const response = await axios.get(`${this.geocodingUrl}/search`, {
        params: {
          name: query,
          count,
          language: 'en',
          format: 'json'
        },
        timeout: 10000
      });

      if (!response.data?.results || response.data.results.length === 0) {
        return {
          success: true,
          results: [],
          message: `No locations found matching "${query}"`
        };
      }

      const results = response.data.results.map(loc => ({
        name: loc.name,
        country: loc.country,
        admin1: loc.admin1,
        latitude: loc.latitude,
        longitude: loc.longitude,
        timezone: loc.timezone,
        population: loc.population,
        display_name: `${loc.name}${loc.admin1 ? ', ' + loc.admin1 : ''}${loc.country ? ', ' + loc.country : ''}`
      }));

      return {
        success: true,
        count: results.length,
        results
      };
    } catch (error) {
      logger.error('Location search failed', { query, error: error.message });
      throw error;
    }
  }

  /**
   * Get current weather
   */
  async getCurrentWeather({ latitude, longitude, city, temperature_unit = 'celsius' }) {
    try {
      // If city provided, geocode it first
      if (city && (!latitude || !longitude)) {
        const location = await this.geocodeLocation(city);
        latitude = location.latitude;
        longitude = location.longitude;
        city = location.name; // Use official name
      }

      if (!latitude || !longitude) {
        throw new Error('Either coordinates (latitude/longitude) or city name is required');
      }

      const tempUnit = temperature_unit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
      
      const response = await axios.get(`${this.baseUrl}/forecast`, {
        params: {
          latitude,
          longitude,
          current: [
            'temperature_2m',
            'relative_humidity_2m',
            'apparent_temperature',
            'is_day',
            'precipitation',
            'rain',
            'showers',
            'snowfall',
            'weather_code',
            'cloud_cover',
            'pressure_msl',
            'surface_pressure',
            'wind_speed_10m',
            'wind_direction_10m',
            'wind_gusts_10m'
          ].join(','),
          temperature_unit: tempUnit,
          wind_speed_unit: 'kmh',
          precipitation_unit: 'mm',
          timezone: 'auto'
        },
        timeout: 15000
      });

      const current = response.data.current;
      const weatherDescription = this.getWeatherDescription(current.weather_code);

      return {
        success: true,
        location: {
          latitude,
          longitude,
          city: city || 'Unknown',
          timezone: response.data.timezone
        },
        time: current.time,
        weather: {
          description: weatherDescription,
          code: current.weather_code,
          temperature: {
            value: current.temperature_2m,
            unit: tempUnit,
            feels_like: current.apparent_temperature
          },
          humidity: {
            value: current.relative_humidity_2m,
            unit: '%'
          },
          precipitation: {
            rain: current.rain || 0,
            showers: current.showers || 0,
            snowfall: current.snowfall || 0,
            total: current.precipitation || 0,
            unit: 'mm'
          },
          wind: {
            speed: current.wind_speed_10m,
            direction: current.wind_direction_10m,
            gusts: current.wind_gusts_10m,
            unit: 'km/h'
          },
          pressure: {
            msl: current.pressure_msl,
            surface: current.surface_pressure,
            unit: 'hPa'
          },
          cloud_cover: {
            value: current.cloud_cover,
            unit: '%'
          },
          is_day: current.is_day === 1
        }
      };
    } catch (error) {
      logger.error('Failed to get current weather', { latitude, longitude, city, error: error.message });
      throw error;
    }
  }

  /**
   * Get weather forecast
   */
  async getWeatherForecast({ latitude, longitude, city, days = 7, temperature_unit = 'celsius', include_hourly = false }) {
    try {
      // If city provided, geocode it first
      if (city && (!latitude || !longitude)) {
        const location = await this.geocodeLocation(city);
        latitude = location.latitude;
        longitude = location.longitude;
        city = location.name;
      }

      if (!latitude || !longitude) {
        throw new Error('Either coordinates (latitude/longitude) or city name is required');
      }

      const tempUnit = temperature_unit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
      const forecastDays = Math.min(Math.max(days, 1), 16);

      const params = {
        latitude,
        longitude,
        daily: [
          'weather_code',
          'temperature_2m_max',
          'temperature_2m_min',
          'apparent_temperature_max',
          'apparent_temperature_min',
          'sunrise',
          'sunset',
          'uv_index_max',
          'precipitation_sum',
          'rain_sum',
          'showers_sum',
          'snowfall_sum',
          'precipitation_hours',
          'precipitation_probability_max',
          'wind_speed_10m_max',
          'wind_gusts_10m_max',
          'wind_direction_10m_dominant'
        ].join(','),
        temperature_unit: tempUnit,
        wind_speed_unit: 'kmh',
        precipitation_unit: 'mm',
        timezone: 'auto',
        forecast_days: forecastDays
      };

      // Add hourly data if requested
      if (include_hourly) {
        params.hourly = [
          'temperature_2m',
          'relative_humidity_2m',
          'precipitation_probability',
          'precipitation',
          'weather_code',
          'wind_speed_10m'
        ].join(',');
      }

      const response = await axios.get(`${this.baseUrl}/forecast`, {
        params,
        timeout: 15000
      });

      const daily = response.data.daily;
      const forecast = [];

      for (let i = 0; i < daily.time.length; i++) {
        forecast.push({
          date: daily.time[i],
          weather: {
            description: this.getWeatherDescription(daily.weather_code[i]),
            code: daily.weather_code[i]
          },
          temperature: {
            max: daily.temperature_2m_max[i],
            min: daily.temperature_2m_min[i],
            feels_like_max: daily.apparent_temperature_max[i],
            feels_like_min: daily.apparent_temperature_min[i],
            unit: tempUnit
          },
          precipitation: {
            sum: daily.precipitation_sum[i],
            rain: daily.rain_sum[i],
            showers: daily.showers_sum[i],
            snowfall: daily.snowfall_sum[i],
            hours: daily.precipitation_hours[i],
            probability_max: daily.precipitation_probability_max[i],
            unit: 'mm'
          },
          wind: {
            max_speed: daily.wind_speed_10m_max[i],
            max_gusts: daily.wind_gusts_10m_max[i],
            dominant_direction: daily.wind_direction_10m_dominant[i],
            unit: 'km/h'
          },
          sun: {
            sunrise: daily.sunrise[i],
            sunset: daily.sunset[i]
          },
          uv_index_max: daily.uv_index_max[i]
        });
      }

      const result = {
        success: true,
        location: {
          latitude,
          longitude,
          city: city || 'Unknown',
          timezone: response.data.timezone
        },
        forecast_days: forecastDays,
        forecast
      };

      // Add hourly data if requested
      if (include_hourly && response.data.hourly) {
        result.hourly = {
          time: response.data.hourly.time,
          temperature: response.data.hourly.temperature_2m,
          humidity: response.data.hourly.relative_humidity_2m,
          precipitation: response.data.hourly.precipitation,
          precipitation_probability: response.data.hourly.precipitation_probability,
          weather_code: response.data.hourly.weather_code,
          wind_speed: response.data.hourly.wind_speed_10m
        };
      }

      return result;
    } catch (error) {
      logger.error('Failed to get weather forecast', { latitude, longitude, city, days, error: error.message });
      throw error;
    }
  }

  /**
   * Convert WMO weather code to description
   * Source: https://open-meteo.com/en/docs
   */
  getWeatherDescription(code) {
    const weatherCodes = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      56: 'Light freezing drizzle',
      57: 'Dense freezing drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      66: 'Light freezing rain',
      67: 'Heavy freezing rain',
      71: 'Slight snow fall',
      73: 'Moderate snow fall',
      75: 'Heavy snow fall',
      77: 'Snow grains',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      85: 'Slight snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail'
    };

    return weatherCodes[code] || 'Unknown';
  }

  /**
   * Execute tool by name (MCP adapter interface)
   */
  async executeTool(toolName, args) {
    switch (toolName) {
      case 'get_current_weather':
        return await this.getCurrentWeather(args);
      case 'get_weather_forecast':
        return await this.getWeatherForecast(args);
      case 'search_location':
        return await this.searchLocation(args.query, args.count);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}

// Export singleton instance
module.exports = new WeatherService();

//Dependency Injection Container
// Manages service dependencies (singletons)
// Lazy initialization (services created only when needed)
// Prevents circular dependencies

// USAGE:
// - Register service
//   container.register('xpathGenerator', () => new XPathGenerator(textUtils, domUtils));
// - Resolve (get instance)
//   const xpathGenerator = container.resolve('xpathGenerator');

import logger from './logger.js';

class DIContainer {
  constructor() {
    this.services = new Map();      
    this.instances = new Map();     
    this.resolving = new Set();     
  }

  //Register a service
  register(name, factory, options = {}) {
    const { singleton = true } = options;

    if (this.services.has(name)) {
      logger.warn(`Service ${name} already registered, overwriting`);
    }

    this.services.set(name, { factory, singleton });
    return this;
  }

  //Resolve a service (get instance)
  resolve(name) {
    if (this.instances.has(name)) {
      return this.instances.get(name);
    }

    if (!this.services.has(name)) {
      throw new Error(`Service "${name}" not registered in DI container`);
    }

    if (this.resolving.has(name)) {
      const chain = Array.from(this.resolving).join(' → ');
      throw new Error(`Circular dependency detected: ${chain} → ${name}`);
    }

    this.resolving.add(name);

    try {
      const { factory, singleton } = this.services.get(name);

      const instance = factory(this); 

      if (singleton) {
        this.instances.set(name, instance);
      }

      logger.debug(`DI: Resolved service "${name}"`, { singleton });
      
      return instance;

    } finally {
      this.resolving.delete(name);
    }
  }

  //Check if service is registered
  has(name) {
    return this.services.has(name);
  }

  //Get all registered service names
  getServiceNames() {
    return Array.from(this.services.keys());
  }

  //Clear all instances (force re-initialization)
  clearInstances() {
    this.instances.clear();
    logger.debug('DI: Cleared all service instances');
    return this;
  }

  //Clear everything (services + instances)
  reset() {
    this.services.clear();
    this.instances.clear();
    this.resolving.clear();
    logger.debug('DI: Reset container');
    return this;
  }

  //Register multiple services at once
  registerAll(services) {
    for (const [name, factory] of Object.entries(services)) {
      this.register(name, factory);
    }
    return this;
  }

  //Resolve multiple services at once
  resolveAll(names) {
    const resolved = {};
    for (const name of names) {
      resolved[name] = this.resolve(name);
    }
    return resolved;
  }
}

export default new DIContainer();

// SERVICE REGISTRY (Define all services here)

//Bootstrap DI container with all services
//Factory functions receive container as parameter
//This allows services to resolve their own dependencies

export function bootstrapServices(container) {
  // Import services lazily (prevents circular imports)
  
  //Registrations (you'll add real ones later):
  

  logger.info('DI: Bootstrapped services', {
    count: container.getServiceNames().length,
    services: container.getServiceNames(),
  });

  return container;
}
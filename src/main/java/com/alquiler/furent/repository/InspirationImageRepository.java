package com.alquiler.furent.repository;

import com.alquiler.furent.model.InspirationImage;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.util.List;

public interface InspirationImageRepository extends MongoRepository<InspirationImage, String> {
    
    List<InspirationImage> findByTenantIdOrderByDisplayOrderAsc(String tenantId);
    
    List<InspirationImage> findByTenantIdAndActiveOrderByDisplayOrderAsc(String tenantId, boolean active);
    
    List<InspirationImage> findByTenantIdAndCategoryAndActiveOrderByDisplayOrderAsc(String tenantId, String category, boolean active);
    
    long countByTenantId(String tenantId);
}
